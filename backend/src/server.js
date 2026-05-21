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
  const [groupsSchemaFile, groupVarsSchemaFile] = await Promise.all([
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
  ]);

  return {
    groupsSchema: JSON.parse(groupsSchemaFile.content),
    groupVarsSchema: JSON.parse(groupVarsSchemaFile.content),
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
  const { groupsSchema, groupVarsSchema } = await getSchemas();
  const groupsValidator = ajv.compile(groupsSchema);
  const groupVarsValidator = ajv.compile(groupVarsSchema);
  const validGroups = groupsValidator(content);
  const errors = [];

  if (!validGroups && groupsValidator.errors) {
    errors.push(
      ...groupsValidator.errors.map((error) => ({
        instancePath: error.instancePath,
        message: error.message,
      }))
    );
  }

  if (content && Array.isArray(content.groups)) {
    content.groups.forEach((group, index) => {
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
              instancePath: `/groups/${index}${error.instancePath}`,
              message: error.message,
            }))
          );
        }
      }

      errors.push(...validateGroupDefaultPrinter(group, index));
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
    return res.status(200).json({ ok: true, ...schemas });
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
