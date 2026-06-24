#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3001);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const WORKSPACE_DIR = process.env.QC_WORKSPACE || ROOT;
const RUNNER = process.env.QC_AUDIT_RUNNER || path.join(ROOT, "run-qc-audit.js");
const DEFAULT_AUDIT_WORKDIR = process.env.QC_AUDIT_WORKDIR || ROOT;
const RUNS_DIR = path.join(WORKSPACE_DIR, "qc-audit-ui-runs");

const jobs = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "audit";
}

function parseLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Website URL is required.");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function buildConfig(input, jobId, outDir) {
  const url = normalizeUrl(input.url);
  const browsers = Array.isArray(input.browsers) && input.browsers.length ? input.browsers : ["chrome"];
  const interactions = Array.isArray(input.interactions) && input.interactions.length ? input.interactions : ["hover", "scroll", "focus", "forms", "click", "sticky"];
  const routes = parseLines(input.routes);
  const scenarios = Array.isArray(input.scenarios)
    ? input.scenarios.filter((scenario) => scenario && scenario.name && Array.isArray(scenario.steps) && scenario.steps.length)
    : [];
  const warnings = [];

  const viewports = {};
  const viewportInputs = input.viewports || {};
  for (const [key, fallback] of Object.entries({
    desktop: { label: "Desktop", width: 1440, height: 1000 },
    tablet: { label: "Tablet", width: 834, height: 1112 },
    mobile: { label: "Mobile", width: 390, height: 844 },
  })) {
    const item = viewportInputs[key] || {};
    const hasReference = Boolean(item.figmaReference || item.figmaReferenceImage);
    if (item.enabled === false && !hasReference) continue;
    viewports[key] = {
      label: fallback.label,
      width: Number(item.width || fallback.width),
      height: Number(item.height || fallback.height),
    };
    if (item.figmaReference) viewports[key].figmaReference = String(item.figmaReference).trim();
    if (item.figmaReferenceImage) viewports[key].figmaReferenceImage = String(item.figmaReferenceImage).trim();
    if (item.figmaReference && !item.figmaReferenceImage) {
      warnings.push(`${fallback.label}: Figma frame URL is saved, but visual diff needs an exported PNG path too.`);
    }
    if (item.enabled === false && hasReference) {
      warnings.push(`${fallback.label}: breakpoint was included because a Figma reference was provided.`);
    }
  }

  const config = {
    runId: jobId,
    url,
    outDir,
    browsers,
    interactions,
    reviewMode: input.reviewMode || "evidence-first",
    confidenceThreshold: input.confidenceThreshold || "low",
    stateCapture: input.stateCapture || {
      hover: interactions.includes("hover"),
      focus: interactions.includes("focus"),
      scroll: interactions.includes("scroll"),
      forms: interactions.includes("forms"),
      openStates: interactions.includes("click"),
      sticky: interactions.includes("sticky"),
      maxTargets: 6,
      maxScrollSections: 6,
    },
    viewports,
    routes: routes.length ? routes : ["/"],
    scenarios,
    timeoutMs: Number(input.timeoutMs || 45000),
  };
  config.figmaFrames = Object.fromEntries(
    Object.entries(viewports)
      .filter(([, viewport]) => viewport.figmaReference)
      .map(([key, viewport]) => [key, viewport.figmaReference])
  );
  if (warnings.length) config.warnings = warnings;

  if (input.discoverRoutes) {
    config.discoverRoutes = {
      maxRoutes: Number(input.maxRoutes || 6),
      maxDepth: Number(input.maxDepth || 1),
      sitemap: Boolean(input.sitemap),
      exclude: ["logout", "signout", "delete", "remove", "mailto:", "tel:"],
    };
  }

  if (input.gates && input.gates.enabled) {
    config.ci = Boolean(input.gates.ci);
    config.gates = {};
    for (const key of ["minScore", "maxCritical", "maxHigh", "maxMedium", "maxLow", "maxFailedEnvironments", "maxSkippedEnvironments", "maxFailedScenarios"]) {
      if (input.gates[key] !== "" && input.gates[key] !== undefined && input.gates[key] !== null) {
        config.gates[key] = Number(input.gates[key]);
      }
    }
  }

  return config;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function publicJob(job, options = {}) {
  const includeReport = options.includeReport !== false;
  let report = null;
  if (includeReport && job.reportJson && fs.existsSync(job.reportJson)) {
    try {
      const parsed = readJsonIfExists(job.reportJson);
      if (!parsed) throw new Error("Unable to parse report.json");
      report = {
        score: parsed.score,
        summary: parsed.summary,
        findings: (parsed.findings || []).slice(0, 12).map((finding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          section: finding.section || finding.location?.section || "Page",
          confidence: finding.confidence || "medium",
          source: finding.source || "rule",
          state: finding.state || "page-load",
          measuredDelta: finding.measuredDelta || null,
          designReference: finding.designReference || null,
          ticket: finding.ticket || null,
          developerTicket: finding.developerTicket || "",
          location: finding.location || null,
          evidence: finding.evidence || {},
          actual: finding.actual,
          suggestedFix: finding.suggestedFix,
          affectedCount: (finding.affectedEnvironments || []).length,
        })),
        matrix: parsed.matrix || [],
        reviewBoard: parsed.reviewBoard || null,
        reviewMode: parsed.reviewMode || "evidence-first",
      };
    } catch (error) {
      report = { error: error.message };
    }
  }

  return {
    id: job.id,
    title: job.title,
    url: job.url,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    outDir: job.outDir,
    configPath: job.configPath,
    reportJson: job.reportJson,
    reportHtml: job.reportHtml,
    developerSummary: job.developerSummary,
    log: job.log.slice(-400),
    report,
  };
}

function hydrateJobsFromDisk() {
  ensureDir(RUNS_DIR);
  const entries = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("qc-"));

  for (const id of entries) {
    if (jobs.has(id)) continue;
    const outDir = path.join(RUNS_DIR, id);
    const configPath = path.join(outDir, "audit-config.json");
    const reportJson = path.join(outDir, "report.json");
    const reportHtml = path.join(outDir, "report.html");
    const developerSummary = path.join(outDir, "developer-summary.md");
    const config = readJsonIfExists(configPath) || {};
    const report = readJsonIfExists(reportJson) || {};
    const stat = fs.existsSync(reportJson) ? fs.statSync(reportJson) : fs.statSync(outDir);
    jobs.set(id, {
      id,
      title: config.title || new URL(config.url || report.url || "https://example.com").hostname,
      url: config.url || report.url || "",
      status: fs.existsSync(reportJson) ? "completed" : "failed",
      createdAt: report.createdAt || stat.birthtime.toISOString(),
      startedAt: null,
      finishedAt: report.createdAt || stat.mtime.toISOString(),
      exitCode: fs.existsSync(reportJson) ? 0 : 1,
      error: fs.existsSync(reportJson) ? null : "Report not found on disk.",
      outDir,
      configPath,
      reportJson,
      reportHtml,
      developerSummary,
      log: [`Recovered run from ${outDir}`],
    });
  }
}

function startAudit(input) {
  ensureDir(RUNS_DIR);
  const host = new URL(normalizeUrl(input.url)).hostname;
  const jobId = `qc-${slug(host)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = path.join(RUNS_DIR, jobId);
  ensureDir(outDir);

  const config = buildConfig(input, jobId, outDir);
  const configPath = path.join(outDir, "audit-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const job = {
    id: jobId,
    title: input.title || host,
    url: config.url,
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    outDir,
    configPath,
    reportJson: path.join(outDir, "report.json"),
    reportHtml: path.join(outDir, "report.html"),
    developerSummary: path.join(outDir, "developer-summary.md"),
    log: [`Starting audit ${jobId}`, `Config: ${configPath}`, `Runner: ${RUNNER}`],
  };
  for (const warning of config.warnings || []) {
    job.log.push(`warning: ${warning}`);
  }
  jobs.set(jobId, job);

  const child = spawn(process.execPath, [RUNNER, "--config", configPath], {
    cwd: fs.existsSync(DEFAULT_AUDIT_WORKDIR) ? DEFAULT_AUDIT_WORKDIR : WORKSPACE_DIR,
    env: {
      ...process.env,
      NODE_PATH: [process.env.NODE_PATH, path.join(ROOT, "node_modules")].filter(Boolean).join(path.delimiter),
    },
  });

  child.stdout.on("data", (data) => {
    job.log.push(...String(data).split(/\r?\n/).filter(Boolean));
  });
  child.stderr.on("data", (data) => {
    job.log.push(...String(data).split(/\r?\n/).filter(Boolean).map((line) => `stderr: ${line}`));
  });
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    job.log.push(`error: ${error.message}`);
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.status = code === 0 || code === 2 ? "completed" : "failed";
    if (code === 2) job.log.push("Audit completed with failed CI gates.");
    job.log.push(`Process exited with code ${code}.`);
  });

  return job;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) return sendText(res, 404, "Not found");
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(data);
  });
}

function safeJoin(base, unsafePath) {
  const resolved = path.resolve(base, unsafePath);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error("Invalid path.");
  }
  return resolved;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      runner: RUNNER,
      runnerExists: fs.existsSync(RUNNER),
      auditWorkdir: DEFAULT_AUDIT_WORKDIR,
      auditWorkdirExists: fs.existsSync(DEFAULT_AUDIT_WORKDIR),
      runsDir: RUNS_DIR,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    hydrateJobsFromDisk();
    const list = Array.from(jobs.values())
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .map((job) => publicJob(job, { includeReport: false }));
    return sendJson(res, 200, list);
  }

  if (req.method === "POST" && url.pathname === "/api/audits") {
    try {
      const input = JSON.parse(await readBody(req) || "{}");
      const job = startAudit(input);
      return sendJson(res, 201, publicJob(job));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    hydrateJobsFromDisk();
    const job = jobs.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found" });
    return sendJson(res, 200, publicJob(job));
  }

  return sendJson(res, 404, { error: "API route not found" });
}

function handleArtifact(req, res, url) {
  const match = url.pathname.match(/^\/artifacts\/([^/]+)\/(.+)$/);
  if (!match) return sendText(res, 404, "Not found");
  hydrateJobsFromDisk();
  const job = jobs.get(match[1]);
  if (!job) return sendText(res, 404, "Job not found");
  try {
    const filePath = safeJoin(job.outDir, decodeURIComponent(match[2]));
    return serveFile(res, filePath);
  } catch (error) {
    return sendText(res, 400, error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  if (url.pathname.startsWith("/artifacts/")) return handleArtifact(req, res, url);

  const filePath = safeJoin(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  return serveFile(res, filePath);
});

ensureDir(RUNS_DIR);
server.listen(PORT, () => {
  console.log(`QC Audit UI running at http://localhost:${PORT}`);
  console.log(`Runs directory: ${RUNS_DIR}`);
});
