const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const tar = require('tar');

const app = express();
const PORT = process.env.PORT || 3000;
const VERCEL_API = 'https://api.vercel.com';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

function normalizeToken(apiKey) {
  let token = String(apiKey || '').trim();
  token = token.replace(/^["']|["']$/g, '');
  token = token.replace(/^Bearer\s+/i, '').trim();
  token = token.replace(/\s+/g, '');
  return token;
}

function vercelHeaders(token) {
  return {
    Authorization: `Bearer ${normalizeToken(token)}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Aman-TechX'
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vercelErrorMessage(err) {
  const data = err.response && err.response.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    if (data.error && data.error.message) return data.error.message;
    if (data.error && typeof data.error === 'string') return data.error;
    if (data.message) return data.message;
  }
  return err.message || 'Unknown error';
}

function sanitizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52);
}

function parseGithubRepo(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (match) {
    return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
  }
  const short = raw.match(/^([^/\s]+)\/([^/#?\s]+)$/);
  if (short) {
    return { owner: short[1], repo: short[2].replace(/\.git$/i, '') };
  }
  return null;
}

async function resolveTarballUrl(owner, repo) {
  const branches = ['main', 'master'];
  for (const branch of branches) {
    const url = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`;
    try {
      const res = await axios.head(url, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (s) => s < 400
      });
      if (res.status < 400) return { url, branch };
    } catch (_) {}
  }
  return {
    url: `https://github.com/${owner}/${repo}/archive/refs/heads/main.tar.gz`,
    branch: 'main'
  };
}

function vercelClient(token, teamId) {
  const headers = vercelHeaders(token);
  const params = {};
  if (teamId) params.teamId = teamId;
  return axios.create({
    baseURL: VERCEL_API,
    headers,
    params,
    timeout: 120000
  });
}

async function resolveTeamId(token, explicit) {
  if (explicit) return String(explicit).trim();
  try {
    const res = await axios.get(`${VERCEL_API}/v2/user`, {
      headers: vercelHeaders(token),
      timeout: 20000
    });
    const user = res.data && (res.data.user || res.data);
    return user.defaultTeamId || null;
  } catch (_) {
    return null;
  }
}

function skipRel(rel) {
  const parts = rel.split('/');
  const skipDir = new Set([
    'node_modules', '.git', '.next', '.vercel', '.cache', 'coverage',
    '__pycache__', '.turbo', '.output', '.nuxt', '.svelte-kit'
  ]);
  if (parts.some((p) => skipDir.has(p))) return true;
  const base = parts[parts.length - 1];
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  return false;
}

function walkFiles(dir, base) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (skipRel(rel)) continue;
    if (ent.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (ent.isFile()) {
      out.push({ abs: full, rel });
    }
  }
  return out;
}

function detectFramework(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    if (deps.next) return 'nextjs';
    if (deps.nuxt || deps['nuxt3']) return 'nuxtjs';
    if (deps['@sveltejs/kit']) return 'sveltekit';
    if (deps.astro) return 'astro';
    if (deps.vite && deps.vue) return 'vue';
    if (deps.vite && (deps.react || deps['react-dom'])) return 'vite';
    if (deps['react-scripts']) return 'create-react-app';
    if (deps.gatsby) return 'gatsby';
  } catch (_) {}
  return null;
}

async function extractTarball(tarballUrl, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const res = await axios.get(tarballUrl, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5
  });
  await new Promise((resolve, reject) => {
    res.data
      .pipe(tar.x({ cwd: destDir, strip: 1 }))
      .on('finish', resolve)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function mapPool(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return ret;
}

async function uploadFilesAndDeploy(client, projectName, rootDir) {
  const files = walkFiles(rootDir, rootDir);
  if (files.length === 0) {
    throw new Error('No files found in GitHub repository');
  }
  const framework = detectFramework(rootDir);
  const uploaded = [];

  await mapPool(files, 6, async (item) => {
    const stat = fs.statSync(item.abs);
    if (stat.size > 45 * 1024 * 1024) return;
    const buf = fs.readFileSync(item.abs);
    const sha = crypto.createHash('sha1').update(buf).digest('hex');
    try {
      const uploadParams = client.defaults.params || {};
      await axios.post(`${VERCEL_API}/v2/files`, buf, {
        headers: {
          Authorization: client.defaults.headers.Authorization,
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.length,
          'x-vercel-digest': sha,
          'User-Agent': 'Aman-TechX'
        },
        params: uploadParams,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
        transformRequest: [(data) => data]
      });
    } catch (err) {
      const status = err.response && err.response.status;
      if (status !== 409) throw err;
    }
    uploaded.push({ file: item.rel, sha: sha, size: buf.length });
  });

  const deployRes = await client.post('/v13/deployments', {
    name: projectName,
    files: uploaded,
    project: projectName,
    target: 'production',
    projectSettings: framework ? { framework: framework } : undefined
  });
  return deployRes.data;
}

async function deployFromGit(client, projectName, owner, repo, branch) {
  const deployRes = await client.post('/v13/deployments', {
    name: projectName,
    project: projectName,
    target: 'production',
    gitSource: {
      type: 'github',
      org: owner,
      repo: repo,
      ref: branch || 'main'
    }
  });
  return deployRes.data;
}

async function ensureProject(client, appName, owner, repo) {
  try {
    const created = await client.post('/v10/projects', {
      name: appName,
      gitRepository: {
        type: 'github',
        repo: `${owner}/${repo}`
      }
    });
    return created.data;
  } catch (err) {
    const status = err.response && err.response.status;
    const msg = vercelErrorMessage(err);
    if (status === 409 || /already exists/i.test(msg)) {
      const existing = await client.get(`/v9/projects/${encodeURIComponent(appName)}`);
      return existing.data;
    }
    if (status === 400 || status === 403 || /git/i.test(msg)) {
      try {
        const created = await client.post('/v10/projects', { name: appName });
        return created.data;
      } catch (err2) {
        const status2 = err2.response && err2.response.status;
        if (status2 === 409) {
          const existing = await client.get(`/v9/projects/${encodeURIComponent(appName)}`);
          return existing.data;
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function setEnvVars(client, appName, vars) {
  let existing = [];
  try {
    const res = await client.get(`/v9/projects/${encodeURIComponent(appName)}/env`, {
      params: { decrypt: 'true' }
    });
    existing = (res.data && res.data.envs) || res.data || [];
    if (!Array.isArray(existing)) existing = [];
  } catch (_) {
    existing = [];
  }

  const byKey = {};
  existing.forEach((item) => {
    if (item && item.key) byKey[item.key] = item;
  });

  for (const [key, value] of Object.entries(vars)) {
    if (value == null || value === '') continue;
    const current = byKey[key];
    if (current && current.id) {
      try {
        await client.patch(
          `/v9/projects/${encodeURIComponent(appName)}/env/${current.id}`,
          { value: String(value), type: 'encrypted', target: ['production', 'preview', 'development'] }
        );
        continue;
      } catch (_) {}
    }
    try {
      await client.post(`/v10/projects/${encodeURIComponent(appName)}/env`, {
        key: key,
        value: String(value),
        type: 'encrypted',
        target: ['production', 'preview', 'development']
      });
    } catch (_) {}
  }
}

function deploymentUrl(deploy, appName) {
  if (deploy && deploy.alias && deploy.alias.length) {
    const a = deploy.alias.find((d) => String(d).endsWith('.vercel.app')) || deploy.alias[0];
    return `https://${a}`;
  }
  if (deploy && deploy.url) {
    const u = String(deploy.url);
    return u.startsWith('http') ? u : `https://${u}`;
  }
  return `https://${appName}.vercel.app`;
}

async function cleanupDir(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (_) {}
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/manager', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

app.post('/venom/deploy-apps', async (req, res) => {
  const {
    githubRepo,
    vercelToken,
    herokuApiKey,
    appName: rawAppName,
    teamId
  } = req.body || {};

  const token = vercelToken || herokuApiKey;
  if (!githubRepo || !token || !rawAppName) {
    return res.status(400).json({ error: 'GitHub repo, Vercel token and app name are required' });
  }

  const parsed = parseGithubRepo(githubRepo);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid GitHub repository URL' });
  }

  const appName = sanitizeName(rawAppName);
  if (!appName) {
    return res.status(400).json({ error: 'Invalid app name' });
  }

  const team = await resolveTeamId(token, teamId);
  const client = vercelClient(token, team);

  let tarball;
  try {
    tarball = await resolveTarballUrl(parsed.owner, parsed.repo);
  } catch (err) {
    return res.status(400).json({ error: 'Could not access GitHub repository' });
  }

  const tmpDir = path.join(os.tmpdir(), `aman-vercel-${appName}-${Date.now()}`);
  try {
    await ensureProject(client, appName, parsed.owner, parsed.repo);
    await setEnvVars(client, appName, {
      GITHUB_REPO: `https://github.com/${parsed.owner}/${parsed.repo}`
    });

    let deploy;
    try {
      deploy = await deployFromGit(client, appName, parsed.owner, parsed.repo, tarball.branch);
    } catch (_) {
      await extractTarball(tarball.url, tmpDir);
      deploy = await uploadFilesAndDeploy(client, appName, tmpDir);
    }

    const appUrl = deploymentUrl(deploy, appName);
    return res.json({
      success: true,
      appName,
      appUrl
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: vercelErrorMessage(err)
    });
  } finally {
    await cleanupDir(tmpDir);
  }
});

app.post('/api/manager/bot-apps', async (req, res) => {
  const { vercelToken, herokuApiKey, teamId } = req.body || {};
  const token = vercelToken || herokuApiKey;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Vercel token required' });
  }

  try {
    const team = await resolveTeamId(token, teamId);
    const client = vercelClient(token, team);
    const apps = [];
    let until = undefined;
    for (let page = 0; page < 20; page++) {
      const response = await client.get('/v9/projects', {
        params: Object.assign({ limit: 100 }, until ? { until: until } : {})
      });
      const list = (response.data && response.data.projects) || [];
      list.forEach((item) => {
        const aliases = Array.isArray(item.alias)
          ? item.alias.map((a) => (typeof a === 'string' ? a : a.domain)).filter(Boolean)
          : [];
        const custom = aliases.find((d) => d && !String(d).endsWith('.vercel.app'));
        const webUrl = custom
          ? `https://${custom}`
          : `https://${item.name}.vercel.app`;
        apps.push({
          name: item.name,
          id: item.id,
          web_url: webUrl,
          created_at: item.createdAt ? new Date(item.createdAt).toISOString() : null,
          updated_at: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
          framework: item.framework || '',
          domain: custom || `${item.name}.vercel.app`
        });
      });
      const pagination = response.data && response.data.pagination;
      if (!pagination || !pagination.next) break;
      until = pagination.next;
    }

    apps.sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ success: true, apps });
  } catch (err) {
    const status = err.response && err.response.status;
    let message = vercelErrorMessage(err);
    if (status === 401 || status === 403) {
      message = 'Invalid Vercel token. Create one at vercel.com/account/tokens';
    } else if (!message || message === 'Unknown error') {
      message = 'Failed to load apps';
    }
    return res.status(status === 401 || status === 403 ? 401 : 500).json({
      success: false,
      error: message
    });
  }
});

async function resolveGithubFromProject(client, appName, fallbackRepo) {
  if (fallbackRepo) {
    const parsed = parseGithubRepo(fallbackRepo);
    if (parsed) return parsed;
  }
  try {
    const project = await client.get(`/v9/projects/${encodeURIComponent(appName)}`);
    const link = project.data && project.data.link;
    if (link && (link.org || link.repo)) {
      const repoName = String(link.repo || '').replace(/\.git$/i, '');
      if (link.org && repoName) return { owner: link.org, repo: repoName };
      if (typeof link.repo === 'string' && link.repo.includes('/')) {
        const [owner, repo] = link.repo.split('/');
        return { owner, repo };
      }
    }
  } catch (_) {}
  try {
    const envRes = await client.get(`/v9/projects/${encodeURIComponent(appName)}/env`, {
      params: { decrypt: 'true' }
    });
    const envs = (envRes.data && envRes.data.envs) || [];
    const found = envs.find((e) => e.key === 'GITHUB_REPO');
    const parsed = parseGithubRepo(found && found.value);
    if (parsed) return parsed;
  } catch (_) {}
  return null;
}

app.post('/api/manager/restart-bot-apps', async (req, res) => {
  const { vercelToken, herokuApiKey, appNames, githubRepo, teamId } = req.body || {};
  const token = vercelToken || herokuApiKey;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Vercel token required' });
  }
  if (!Array.isArray(appNames) || appNames.length === 0) {
    return res.status(400).json({ success: false, error: 'No apps selected' });
  }

  const team = await resolveTeamId(token, teamId);
  const client = vercelClient(token, team);
  let restarted = 0;
  const errors = [];

  for (const name of appNames) {
    const tmpDir = path.join(os.tmpdir(), `aman-vercel-push-${name}-${Date.now()}`);
    try {
      const parsed = await resolveGithubFromProject(client, name, githubRepo);
      if (!parsed) {
        throw new Error('GitHub repository not linked. Set GITHUB_REPO or pass repo URL.');
      }
      const tarball = await resolveTarballUrl(parsed.owner, parsed.repo);
      try {
        await deployFromGit(client, name, parsed.owner, parsed.repo, tarball.branch);
      } catch (_) {
        await extractTarball(tarball.url, tmpDir);
        await uploadFilesAndDeploy(client, name, tmpDir);
      }
      restarted += 1;
    } catch (err) {
      errors.push({
        appName: name,
        error: vercelErrorMessage(err)
      });
    } finally {
      await cleanupDir(tmpDir);
    }
    await sleep(300);
  }

  return res.json({
    success: errors.length === 0,
    message: `Pushed latest GitHub code and redeployed ${restarted} app(s)${errors.length ? `, ${errors.length} failed` : ''}`,
    restarted,
    errors
  });
});

app.post('/api/manager/delete-bot-apps', async (req, res) => {
  const { vercelToken, herokuApiKey, appNames, teamId } = req.body || {};
  const token = vercelToken || herokuApiKey;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Vercel token required' });
  }
  if (!Array.isArray(appNames) || appNames.length === 0) {
    return res.status(400).json({ success: false, error: 'No apps selected' });
  }

  const team = await resolveTeamId(token, teamId);
  const client = vercelClient(token, team);
  let deleted = 0;
  const errors = [];

  for (const name of appNames) {
    try {
      await client.delete(`/v9/projects/${encodeURIComponent(name)}`);
      deleted += 1;
    } catch (err) {
      errors.push({
        appName: name,
        error: vercelErrorMessage(err)
      });
    }
  }

  return res.json({
    success: errors.length === 0,
    message: `Deleted ${deleted} app(s)${errors.length ? `, ${errors.length} failed` : ''}`,
    deleted,
    errors
  });
});

app.get('/manage/:appName', async (req, res) => {
  const token = req.query.vercelToken || req.query.herokuApiKey || req.query.apiKey;
  const teamId = req.query.teamId;
  const { appName } = req.params;
  if (!token) {
    return res.status(400).json({ success: false, error: 'API token required' });
  }

  try {
    const team = await resolveTeamId(token, teamId);
    const client = vercelClient(token, team);
    const response = await client.get(`/v9/projects/${encodeURIComponent(appName)}/env`, {
      params: { decrypt: 'true' }
    });
    const envs = (response.data && response.data.envs) || [];
    const config = {};
    envs.forEach((item) => {
      if (item && item.key) config[item.key] = item.value == null ? '' : String(item.value);
    });
    return res.json({ success: true, config: config });
  } catch (err) {
    return res.status(err.response && err.response.status ? err.response.status : 500).json({
      success: false,
      error: vercelErrorMessage(err) || 'Failed to load config'
    });
  }
});

app.put('/manage/:appName/config', async (req, res) => {
  const { appName } = req.params;
  const { configVars, apiKey, vercelToken, herokuApiKey, teamId } = req.body || {};
  const token = vercelToken || apiKey || herokuApiKey;

  if (!token) {
    return res.status(400).json({ success: false, error: 'API token required' });
  }
  if (!configVars || typeof configVars !== 'object') {
    return res.status(400).json({ success: false, error: 'configVars required' });
  }

  try {
    const team = await resolveTeamId(token, teamId);
    const client = vercelClient(token, team);
    const envRes = await client.get(`/v9/projects/${encodeURIComponent(appName)}/env`, {
      params: { decrypt: 'true' }
    });
    const existing = (envRes.data && envRes.data.envs) || [];
    const byKey = {};
    existing.forEach((item) => {
      if (item && item.key) byKey[item.key] = item;
    });

    for (const [key, value] of Object.entries(configVars)) {
      const current = byKey[key];
      if (value === null) {
        if (current && current.id) {
          await client.delete(`/v9/projects/${encodeURIComponent(appName)}/env/${current.id}`);
        }
        continue;
      }
      if (current && current.id) {
        try {
          await client.patch(
            `/v9/projects/${encodeURIComponent(appName)}/env/${current.id}`,
            { value: String(value), type: 'encrypted', target: ['production', 'preview', 'development'] }
          );
          continue;
        } catch (_) {
          await client.delete(`/v9/projects/${encodeURIComponent(appName)}/env/${current.id}`);
        }
      }
      await client.post(`/v10/projects/${encodeURIComponent(appName)}/env`, {
        key: key,
        value: String(value),
        type: 'encrypted',
        target: ['production', 'preview', 'development']
      });
    }

    const refreshed = await client.get(`/v9/projects/${encodeURIComponent(appName)}/env`, {
      params: { decrypt: 'true' }
    });
    const envs = (refreshed.data && refreshed.data.envs) || [];
    const config = {};
    envs.forEach((item) => {
      if (item && item.key) config[item.key] = item.value == null ? '' : String(item.value);
    });
    return res.json({ success: true, config: config });
  } catch (err) {
    return res.status(err.response && err.response.status ? err.response.status : 500).json({
      success: false,
      error: vercelErrorMessage(err) || 'Failed to update config'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aman TechX Vercel Deployer running on http://0.0.0.0:${PORT}`);
});
