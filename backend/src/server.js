import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import yaml from 'js-yaml';
import { Octokit } from 'octokit';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'];
const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);

if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const branch = process.env.GITHUB_BRANCH || 'main';
const schemaOwner = process.env.GITHUB_SCHEMA_OWNER || 'OS2borgerPC';
const schemaRepo = process.env.GITHUB_SCHEMA_REPO || 'sikker-selvbetjening';
const schemaBranch = process.env.GITHUB_SCHEMA_BRANCH || 'main';
const schemaPath =
  process.env.GITHUB_SCHEMA_PATH || 'system_files/usr/share/sikker-selvbetjening/schemas';
const uiSchemaPath = process.env.GITHUB_UI_SCHEMA_PATH || schemaPath;
const groupsUiSchemaFileName = process.env.GROUPS_UI_SCHEMA_FILE || 'groups.uischema.json';
const buildTargetsUiSchemaFileName =
  process.env.BUILD_TARGETS_UI_SCHEMA_FILE || 'build_targets.uischema.json';
const availableDomains = String(process.env.AVAILABLE_DOMAINS || '')
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean);
const currentDomain =
  typeof process.env.CURRENT_DOMAIN === 'string' && process.env.CURRENT_DOMAIN.trim()
    ? process.env.CURRENT_DOMAIN.trim()
    : availableDomains[0] || 'default';

const createAjv = () => {
  const validator = new Ajv2020({ allErrors: true, strict: false });
  addFormats(validator);
  return validator;
};

app.use(
  cors({
    origin: frontendOrigin,
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const isYamlPath = (path) => path.endsWith('.yml') || path.endsWith('.yaml');

const assertRepoPath = (path) => {
  if (!path || typeof path !== 'string') {
    return '"path" is required and must be a string.';
  }

  if (path.startsWith('/') || path.includes('..')) {
    return 'Invalid path. Use a repository-relative file path.';
  }

  return null;
};

const getGithubFile = async ({ owner: requestOwner, repo: requestRepo, path, ref }) => {
  const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: requestOwner,
    repo: requestRepo,
    path,
    ref,
  });

  if (Array.isArray(response.data)) {
    throw new Error(`Expected file but found directory at ${path}`);
  }

  const decoded = Buffer.from(response.data.content, 'base64').toString('utf8');
  return {
    sha: response.data.sha,
    content: decoded,
  };
};

const getRepoFile = async (path) =>
  getGithubFile({
    owner,
    repo,
    path,
    ref: branch,
  });

const getExistingRepoFile = async (path) => {
  try {
    const existing = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path,
      ref: branch,
    });

    if (Array.isArray(existing.data)) {
      throw new Error(`Expected file but found directory at ${path}`);
    }

    return {
      sha: existing.data.sha,
      contentBase64: String(existing.data.content || '').replace(/\n/g, ''),
    };
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }

    throw error;
  }
};

const upsertRepoContent = async ({ path, contentBase64, message }) => {
  const existing = await getExistingRepoFile(path);

  if (existing && existing.contentBase64 === contentBase64) {
    return {
      skipped: true,
      commitSha: null,
      htmlUrl: null,
    };
  }

  const response = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path,
    branch,
    message,
    content: contentBase64,
    sha: existing?.sha,
  });

  return {
    skipped: false,
    commitSha: response.data.commit.sha,
    htmlUrl: response.data.commit.html_url,
  };
};

const getOptionalGithubJson = async ({ owner, repo, path, ref }) => {
  try {
    const file = await getGithubFile({ owner, repo, path, ref });
    return JSON.parse(file.content);
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }

    throw error;
  }
};

const getSchemas = async () => {
  const [
    groupsSchemaFile,
    buildTargetsSchemaFile,
    groupsUiSchema,
    buildTargetsUiSchema,
  ] = await Promise.all([
    getGithubFile({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${schemaPath}/groups.schema.json`,
      ref: schemaBranch,
    }),
    getGithubFile({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${schemaPath}/build_targets.schema.json`,
      ref: schemaBranch,
    }),
    getOptionalGithubJson({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${uiSchemaPath}/${groupsUiSchemaFileName}`,
      ref: schemaBranch,
    }),
    getOptionalGithubJson({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${uiSchemaPath}/${buildTargetsUiSchemaFileName}`,
      ref: schemaBranch,
    }),
  ]);

  return {
    groupsSchema: JSON.parse(groupsSchemaFile.content),
    buildTargetsSchema: JSON.parse(buildTargetsSchemaFile.content),
    groupsUiSchema,
    buildTargetsUiSchema,
  };
};

const validateGroupDefaultPrinter = (group, index) => {
  const printer = group?.printer;

  if (!printer?.default_printer) {
    return [];
  }

  const defaultPrinter = printer.default_printer;
  const keysNoPpd = printer.no_ppd ? Object.keys(printer.no_ppd) : [];
  const keysWithPpd = printer.with_ppd ? Object.keys(printer.with_ppd) : [];
  const allKeys = new Set([...keysNoPpd, ...keysWithPpd]);

  if (!allKeys.has(defaultPrinter)) {
    return [
      {
        instancePath: `/groups/${index}/printer/default_printer`,
        message: 'must reference a key in printer.no_ppd or printer.with_ppd',
      },
    ];
  }

  return [];
};

const validateGroupBackgroundImagePath = (group, domainName, domainIndex, groupIndex) => {
  const value = group?.desktop?.background_image_file;
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }

  const expectedPrefix = `assets/${domainName}/`;
  if (value.startsWith(expectedPrefix)) {
    return [];
  }

  return [
    {
      instancePath: `/domains/${domainIndex}/groups/${groupIndex}/desktop/background_image_file`,
      message: `must start with ${expectedPrefix}`,
    },
  ];
};

const validateGroupsPayload = async (content) => {
  const ajv = createAjv();
  const { groupsSchema, buildTargetsSchema } = await getSchemas();
  const groupsValidator = ajv.compile(groupsSchema);
  const buildTargetsValidator = ajv.compile(buildTargetsSchema);
  const errors = [];

  const domains = content && Array.isArray(content.domains) ? content.domains : [];
  const groupsOnlyPayload = {
    domains: domains.map((domainEntry) => ({
      domain: domainEntry?.domain,
      groups: Array.isArray(domainEntry?.groups) ? domainEntry.groups : [],
    })),
  };
  const buildTargetsOnlyDomains = domains.filter(
    (domainEntry) => Array.isArray(domainEntry?.build_targets) && domainEntry.build_targets.length > 0
  );
  const buildTargetsOnlyPayload = {
    domains: buildTargetsOnlyDomains.map((domainEntry) => ({
      domain: domainEntry?.domain,
      build_targets: domainEntry.build_targets,
    })),
  };

  const validGroups = groupsValidator(groupsOnlyPayload);
  const validBuildTargets =
    buildTargetsOnlyPayload.domains.length === 0 || buildTargetsValidator(buildTargetsOnlyPayload);

  if (!validGroups && groupsValidator.errors) {
    errors.push(
      ...groupsValidator.errors.map((error) => ({
        instancePath: error.instancePath,
        message: error.message,
      }))
    );
  }

  if (!validBuildTargets && buildTargetsValidator.errors) {
    errors.push(
      ...buildTargetsValidator.errors.map((error) => ({
        instancePath: error.instancePath,
        message: error.message,
      }))
    );
  }

  if (content && Array.isArray(content.domains)) {
    if (availableDomains.length > 0) {
      const allowedDomains = new Set(availableDomains);
      content.domains.forEach((domainEntry, domainIndex) => {
        if (!allowedDomains.has(domainEntry?.domain)) {
          errors.push({
            instancePath: `/domains/${domainIndex}/domain`,
            message: `must be one of configured AVAILABLE_DOMAINS (${availableDomains.join(', ')})`,
          });
        }
      });
    }

    content.domains.forEach((domainEntry, domainIndex) => {
      const domainGroups = Array.isArray(domainEntry?.groups) ? domainEntry.groups : [];
      const domainBuildTargets = Array.isArray(domainEntry?.build_targets)
        ? domainEntry.build_targets
        : [];
      const knownGroupNames = new Set(
        domainGroups.map((group) => group?.name).filter((name) => typeof name === 'string')
      );

      domainGroups.forEach((group, groupIndex) => {
        const printerErrors = validateGroupDefaultPrinter(group, groupIndex).map((error) => ({
          ...error,
          instancePath: error.instancePath.replace(
            `/groups/${groupIndex}`,
            `/domains/${domainIndex}/groups/${groupIndex}`
          ),
        }));
        errors.push(...printerErrors);
        errors.push(
          ...validateGroupBackgroundImagePath(
            group,
            String(domainEntry?.domain || ''),
            domainIndex,
            groupIndex
          )
        );
      });

      domainBuildTargets.forEach((buildTarget, buildTargetIndex) => {
        const targetGroups = Array.isArray(buildTarget?.groups) ? buildTarget.groups : [];

        targetGroups.forEach((groupName, groupNameIndex) => {
          if (!knownGroupNames.has(groupName)) {
            errors.push({
              instancePath: `/domains/${domainIndex}/build_targets/${buildTargetIndex}/groups/${groupNameIndex}`,
              message: `must reference an existing group in domains[${domainIndex}].groups`,
            });
          }
        });
      });
    });
  }

  return errors;
};

app.get('/api/file', async (req, res) => {
  const path = req.query.path;
  const pathError = assertRepoPath(path);

  if (pathError) {
    return res.status(400).json({ error: pathError });
  }

  try {
    const file = await getRepoFile(path);
    let parsed = null;

    if (isYamlPath(path)) {
      parsed = yaml.load(file.content);
    } else if (path.endsWith('.json')) {
      parsed = JSON.parse(file.content);
    }

    return res.status(200).json({
      ok: true,
      path,
      parsed,
      raw: file.content,
      sha: file.sha,
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: `File not found: ${path}` });
    }

    console.error('Failed to fetch file from GitHub:', error);
    return res.status(500).json({
      error: 'Failed to fetch file from GitHub.',
      details: error.message,
    });
  }
});

app.get('/api/schemas', async (_req, res) => {
  try {
    const schemas = await getSchemas();
    return res.status(200).json({ ok: true, availableDomains, currentDomain, ...schemas });
  } catch (error) {
    console.error('Failed to fetch schemas from GitHub:', error);
    return res.status(500).json({
      error: 'Failed to fetch schemas from GitHub.',
      details: error.message,
    });
  }
});

app.post('/api/save', async (req, res) => {
  const { path, content, message, assets } = req.body ?? {};
  const pathError = assertRepoPath(path);

  if (pathError) {
    return res.status(400).json({ error: pathError });
  }

  if (content === undefined) {
    return res.status(400).json({ error: '"content" is required.' });
  }

  if (!(path.endsWith('.json') || isYamlPath(path))) {
    return res.status(400).json({ error: 'Only .json, .yml, and .yaml files are allowed.' });
  }

  if (assets !== undefined) {
    if (!Array.isArray(assets)) {
      return res.status(400).json({ error: '"assets" must be an array when provided.' });
    }

    for (const asset of assets) {
      const assetPath = asset?.path;
      const assetPathError = assertRepoPath(assetPath);
      if (assetPathError) {
        return res.status(400).json({ error: `Invalid asset path: ${assetPathError}` });
      }

      if (!assetPath.startsWith('assets/')) {
        return res.status(400).json({ error: `Asset path must start with assets/: ${assetPath}` });
      }

      if (typeof asset?.contentBase64 !== 'string' || asset.contentBase64.trim().length === 0) {
        return res.status(400).json({ error: `Asset contentBase64 is required for ${assetPath}.` });
      }
    }
  }

  if (path === 'config/groups.yml' || path === 'config/groups.yaml') {
    try {
      const validationErrors = await validateGroupsPayload(content);
      if (validationErrors.length > 0) {
        return res.status(400).json({
          error: 'Schema validation failed.',
          validationErrors,
        });
      }
    } catch (error) {
      console.error('Failed to run schema validation:', error);
      return res.status(500).json({
        error: 'Failed to validate content against schemas.',
        details: error.message,
      });
    }
  }

  const serializedContent = isYamlPath(path)
    ? yaml.dump(content, { lineWidth: 120, noRefs: true })
    : JSON.stringify(content, null, 2) + '\n';
  const encodedContent = Buffer.from(serializedContent).toString('base64');

  try {
    const commitMessage =
      typeof message === 'string' && message.trim() ? message.trim() : `Update ${path} via form`;
    const uploadedAssets = [];

    if (Array.isArray(assets) && assets.length > 0) {
      for (const asset of assets) {
        const assetResult = await upsertRepoContent({
          path: asset.path,
          contentBase64: asset.contentBase64,
          message: `Upload ${asset.path} via form`,
        });

        uploadedAssets.push({
          path: asset.path,
          skipped: assetResult.skipped,
          commitSha: assetResult.commitSha,
        });
      }
    }

    const response = await upsertRepoContent({
      path,
      contentBase64: encodedContent,
      message: commitMessage,
    });

    if (response.skipped) {
      return res.status(200).json({
        ok: true,
        commitSha: null,
        htmlUrl: null,
        uploadedAssets,
        message: 'No changes to commit.',
      });
    }

    return res.status(200).json({
      ok: true,
      commitSha: response.commitSha,
      htmlUrl: response.htmlUrl,
      uploadedAssets,
    });
  } catch (error) {
    console.error('Failed to save content to GitHub:', error);
    return res.status(500).json({
      error: 'Failed to save content to GitHub.',
      details: error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
