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

const getSchemas = async () => {
  const [groupsSchemaFile, groupVarsSchemaFile, buildTargetsSchemaFile] = await Promise.all([
    getGithubFile({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${schemaPath}/groups.schema.json`,
      ref: schemaBranch,
    }),
    getGithubFile({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${schemaPath}/group-vars.schema.json`,
      ref: schemaBranch,
    }),
    getGithubFile({
      owner: schemaOwner,
      repo: schemaRepo,
      path: `${schemaPath}/build_targets.schema.json`,
      ref: schemaBranch,
    }),
  ]);

  return {
    groupsSchema: JSON.parse(groupsSchemaFile.content),
    groupVarsSchema: JSON.parse(groupVarsSchemaFile.content),
    buildTargetsSchema: JSON.parse(buildTargetsSchemaFile.content),
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

const validateGroupsPayload = async (content) => {
  const ajv = createAjv();
  const { groupsSchema, groupVarsSchema, buildTargetsSchema } = await getSchemas();
  const groupsValidator = ajv.compile(groupsSchema);
  const groupVarsValidator = ajv.compile(groupVarsSchema);
  const buildTargetsValidator = ajv.compile(buildTargetsSchema);
  const validGroups = groupsValidator(content);
  const validBuildTargets = buildTargetsValidator(content);
  const errors = [];

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
      const overlay = {
        desktop: group.desktop,
        printer: group.printer,
        wifi: group.wifi,
      };

      const hasAnyOverlaySection = Object.values(overlay).some((section) => section !== undefined);

      if (hasAnyOverlaySection) {
        const validOverlay = groupVarsValidator(overlay);

        if (!validOverlay && groupVarsValidator.errors) {
          errors.push(
            ...groupVarsValidator.errors.map((error) => ({
              instancePath: `/domains/${domainIndex}/groups/${groupIndex}${error.instancePath}`,
              message: error.message,
            }))
          );
        }
      }

      const printerErrors = validateGroupDefaultPrinter(group, groupIndex).map((error) => ({
        ...error,
        instancePath: error.instancePath.replace(
          `/groups/${groupIndex}`,
          `/domains/${domainIndex}/groups/${groupIndex}`
        ),
      }));
      errors.push(...printerErrors);
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
  const { path, content, message } = req.body ?? {};
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
    let sha;

    try {
      const existing = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        ref: branch,
      });

      if (!Array.isArray(existing.data)) {
        sha = existing.data.sha;
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    const response = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path,
      branch,
      message: typeof message === 'string' && message.trim() ? message.trim() : `Update ${path} via form`,
      content: encodedContent,
      sha,
    });

    return res.status(200).json({
      ok: true,
      commitSha: response.data.commit.sha,
      htmlUrl: response.data.commit.html_url,
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
