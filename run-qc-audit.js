#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const DEFAULT_VIEWPORTS = {
  desktop: { label: "Desktop", width: 1440, height: 1000 },
  tablet: { label: "Tablet", width: 834, height: 1112 },
  mobile: { label: "Mobile", width: 390, height: 844 },
};

const INSTALLED_BROWSER_PATHS = {
  chrome: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  opera: [
    "/Applications/Opera.app/Contents/MacOS/Opera",
    "/Applications/Opera GX.app/Contents/MacOS/Opera GX",
  ],
  vivaldi: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi"],
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function loadConfig(args) {
  if (args.help) {
    console.log("Usage: run-qc-audit.js --config audit.json");
    process.exit(0);
  }
  if (!args.config) {
    throw new Error("Missing --config <audit.json>");
  }
  const configPath = path.resolve(args.config);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.url) {
    throw new Error("Config must include url");
  }
  return { config, configPath };
}

function tryRequirePlaywright() {
  const attempts = [
    () => createRequire(path.join(process.cwd(), "package.json"))("playwright"),
    () => require("playwright"),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // Try the next resolution root.
    }
  }
  try {
    return createRequire(path.join(process.cwd(), "package.json"))("@playwright/test");
  } catch {
    throw new Error("Playwright is required in the audit working directory. Run npm install -D playwright or npm install -D @playwright/test, then rerun the audit.");
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetArtifactDir(outDir, name) {
  const target = path.join(outDir, name);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  ensureDir(target);
}

function browserExecutable(name) {
  const candidates = INSTALLED_BROWSER_PATHS[name] || [];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function requestedBrowsers(config) {
  return config.browsers && config.browsers.length
    ? config.browsers
    : ["chromium", "firefox", "webkit", "chrome", "edge", "brave", "opera", "vivaldi"];
}

function viewports(config) {
  return Object.entries(config.viewports || DEFAULT_VIEWPORTS).map(([key, value]) => ({
    key,
    label: value.label || key,
    width: Number(value.width),
    height: Number(value.height),
    figmaReference:
      value.figmaReference ||
      value.figmaFrame ||
      config.figmaFrames?.[key] ||
      config.figmaReferences?.[key] ||
      null,
    figmaReferenceImage:
      value.figmaReferenceImage ||
      value.figmaReferencePath ||
      config.figmaReferenceImages?.[key] ||
      config.figmaReferencePaths?.[key] ||
      null,
  }));
}

function routesFor(config) {
  const configured = config.routes && config.routes.length ? config.routes : [{ id: "home", label: "Home", url: config.url }];
  return configured.map((route, index) => {
    if (typeof route === "string") {
      const url = new URL(route, config.url).toString();
      return {
        id: slug(route) || `route-${index + 1}`,
        label: route,
        url,
      };
    }
    const rawUrl = route.url || route.path || config.url;
    return {
      id: slug(route.id || route.name || route.label || rawUrl) || `route-${index + 1}`,
      label: route.label || route.name || route.id || rawUrl,
      url: new URL(rawUrl, config.url).toString(),
      figmaFrames: route.figmaFrames || {},
      figmaReferences: route.figmaReferences || {},
      figmaReferenceImages: route.figmaReferenceImages || {},
    };
  });
}

function routeKey(route) {
  try {
    const url = new URL(route.url);
    url.hash = "";
    return url.toString();
  } catch {
    return route.url;
  }
}

function mergeRoutes(baseRoutes, discoveredRoutes, limit) {
  const merged = [];
  const seen = new Set();
  for (const route of [...baseRoutes, ...discoveredRoutes]) {
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(route);
    if (limit && merged.length >= limit) break;
  }
  return merged;
}

async function readTextUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    return fs.readFileSync(parsed.pathname, "utf8");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function sitemapUrlsFor(config, options) {
  const configured = options.sitemaps || config.sitemaps || [];
  const urls = Array.isArray(configured) ? configured : [configured];
  if (options.sitemap || config.sitemap) {
    urls.push(new URL("/sitemap.xml", config.url).toString());
  }
  return urls.filter(Boolean).map((url) => new URL(url, config.url).toString());
}

async function discoverSitemapRoutes(config, options, baseRoutes, maxRoutes, include, exclude) {
  const sitemapUrls = sitemapUrlsFor(config, options);
  const baseUrl = new URL(config.url);
  const discovered = [];
  const errors = [];

  for (const sitemapUrl of sitemapUrls) {
    if (baseRoutes.length + discovered.length >= maxRoutes) break;
    try {
      const text = await readTextUrl(sitemapUrl);
      const urls = Array.from(text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((match) => match[1].trim());
      for (const rawUrl of urls) {
        const url = new URL(rawUrl, config.url);
        url.hash = "";
        const sameScope = baseUrl.protocol === "file:" ? url.protocol === "file:" : url.origin === baseUrl.origin;
        if (!sameScope) continue;
        const normalized = url.toString();
        if (exclude.some((pattern) => pattern.test(normalized))) continue;
        if (include.length && !include.some((pattern) => pattern.test(normalized))) continue;
        if ([...baseRoutes, ...discovered].some((existing) => routeKey(existing) === normalized)) continue;
        discovered.push({
          id: slug(url.pathname || normalized) || `sitemap-${discovered.length + 1}`,
          label: url.pathname || normalized,
          url: normalized,
          discovered: true,
          source: "sitemap",
          sitemap: sitemapUrl,
        });
        if (baseRoutes.length + discovered.length >= maxRoutes) break;
      }
    } catch (error) {
      errors.push(`${sitemapUrl}: ${error.message}`);
    }
  }

  return { discovered, errors };
}

async function discoverRoutes(playwright, config, baseRoutes, viewport) {
  const discovery = config.discoverRoutes || config.routeDiscovery;
  if (!discovery) return { routes: baseRoutes, discovered: [], error: null };

  const options = typeof discovery === "object" ? discovery : {};
  const maxRoutes = options.maxRoutes ?? config.maxRoutes ?? 12;
  const maxDepth = options.maxDepth ?? 1;
  const include = (options.include || []).map((pattern) => new RegExp(pattern));
  const exclude = (options.exclude || ["logout", "signout", "delete", "remove"]).map((pattern) => new RegExp(pattern, "i"));
  const sitemapResult = await discoverSitemapRoutes(config, options, baseRoutes, maxRoutes, include, exclude);
  const baseUrl = new URL(config.url);
  const origin = baseUrl.origin;
  const discovered = [...sitemapResult.discovered];
  const queued = baseRoutes.map((route) => ({ route, depth: 0 }));
  const visited = new Set();
  const browserName = options.browser || "chromium";
  const browserType = playwright[browserName] || playwright.chromium;
  let browser;

  if (maxDepth < 1) {
    return {
      routes: mergeRoutes(baseRoutes, discovered, maxRoutes),
      discovered,
      error: sitemapResult.errors.length ? sitemapResult.errors.join(" | ") : null,
    };
  }

  try {
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext(contextOptions(config, viewport));
    const page = await context.newPage();
    await applySessionSetup(context, page, config, baseRoutes[0]?.url || config.url);

    while (queued.length > 0 && baseRoutes.length + discovered.length < maxRoutes) {
      const { route, depth } = queued.shift();
      const key = routeKey(route);
      if (visited.has(key) || depth > maxDepth) continue;
      visited.add(key);

      await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs || 45000 });
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .map((link) => ({ href: link.href, text: (link.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) }))
          .filter((link) => link.href)
      );

      for (const link of links) {
        const url = new URL(link.href);
        url.hash = "";
        const sameScope = baseUrl.protocol === "file:" ? url.protocol === "file:" : url.origin === origin;
        if (!sameScope) continue;
        if (!["http:", "https:", "file:"].includes(url.protocol)) continue;
        const normalized = url.toString();
        if (exclude.some((pattern) => pattern.test(normalized) || pattern.test(link.text))) continue;
        if (include.length && !include.some((pattern) => pattern.test(normalized) || pattern.test(link.text))) continue;
        if ([...baseRoutes, ...discovered].some((existing) => routeKey(existing) === normalized)) continue;
        const discoveredRoute = {
          id: slug(url.pathname || link.text || normalized) || `discovered-${discovered.length + 1}`,
          label: link.text || url.pathname || normalized,
          url: normalized,
          discovered: true,
        };
        discovered.push(discoveredRoute);
        if (depth + 1 <= maxDepth) {
          queued.push({ route: discoveredRoute, depth: depth + 1 });
        }
        if (baseRoutes.length + discovered.length >= maxRoutes) break;
      }
    }
  } catch (error) {
    const errors = [...sitemapResult.errors, error.message];
    return { routes: mergeRoutes(baseRoutes, discovered, maxRoutes), discovered, error: errors.join(" | ") || null };
  } finally {
    if (browser) await browser.close();
  }

  return { routes: mergeRoutes(baseRoutes, discovered, maxRoutes), discovered, error: sitemapResult.errors.length ? sitemapResult.errors.join(" | ") : null };
}

function routeViewport(viewport, route) {
  return {
    ...viewport,
    figmaReference: route.figmaFrames?.[viewport.key] || route.figmaReferences?.[viewport.key] || viewport.figmaReference,
    figmaReferenceImage: route.figmaReferenceImages?.[viewport.key] || viewport.figmaReferenceImage,
  };
}

function contextOptions(config, viewport) {
  const options = {
    viewport: { width: viewport.width, height: viewport.height },
  };
  if (config.storageState) {
    options.storageState = path.resolve(config.storageState);
  }
  if (config.locale) options.locale = config.locale;
  if (config.timezoneId) options.timezoneId = config.timezoneId;
  if (config.permissions) options.permissions = config.permissions;
  if (config.extraHTTPHeaders) options.extraHTTPHeaders = config.extraHTTPHeaders;
  if (config.userAgent) options.userAgent = config.userAgent;
  return options;
}

async function applySessionSetup(context, page, config, routeUrl) {
  if (Array.isArray(config.cookies) && config.cookies.length > 0) {
    await context.addCookies(config.cookies);
  }
  for (const script of config.initScripts || []) {
    if (script.path) {
      await context.addInitScript({ path: path.resolve(script.path) });
    } else if (script.content) {
      await context.addInitScript(script.content);
    }
  }
  if (config.localStorage || config.sessionStorage) {
    await page.goto(routeUrl || config.url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs || 45000 });
    await page.evaluate(({ localStorageValues, sessionStorageValues }) => {
      for (const [key, value] of Object.entries(localStorageValues || {})) {
        window.localStorage.setItem(key, String(value));
      }
      for (const [key, value] of Object.entries(sessionStorageValues || {})) {
        window.sessionStorage.setItem(key, String(value));
      }
    }, { localStorageValues: config.localStorage, sessionStorageValues: config.sessionStorage });
  }
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function severityWeight(severity) {
  return { critical: 30, high: 16, medium: 7, low: 2 }[severity] || 1;
}

function confidenceForFinding(finding) {
  if (finding.confidence) return finding.confidence;
  if (finding.source === "agent-review") return "low";
  if (finding.category === "design parity") return finding.measuredDelta || finding.evidence?.diff ? "medium" : "low";
  if (finding.examples?.some((example) => rectFromExample(example))) return "high";
  if (["responsive layout", "accessibility", "interaction", "console/network", "performance"].includes(finding.category)) return "high";
  return "medium";
}

function sourceForFinding(finding) {
  if (finding.source) return finding.source;
  if (finding.category === "design parity") return "figma-parity";
  if (finding.category === "interaction") return "interaction";
  return "rule";
}

function stateForFinding(finding) {
  if (finding.state) return finding.state;
  if (finding.category === "interaction") return "interaction";
  if (finding.category === "design parity") return "settled";
  return "page-load";
}

function addFinding(findings, finding) {
  const id = `F-${String(findings.length + 1).padStart(3, "0")}`;
  const normalized = {
    id,
    examples: finding.examples || [],
    source: sourceForFinding(finding),
    state: stateForFinding(finding),
    ...finding,
  };
  normalized.confidence = confidenceForFinding(normalized);
  findings.push({
    ...normalized,
  });
}

function readPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") {
    throw new Error(`${filePath} is not a PNG file`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function htmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadPngModule() {
  try {
    return createRequire(path.join(process.cwd(), "package.json"))("pngjs").PNG;
  } catch {
    return null;
  }
}

function blendPixel(png, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  const inverse = 1 - alpha;
  png.data[idx] = Math.round(png.data[idx] * inverse + color[0] * alpha);
  png.data[idx + 1] = Math.round(png.data[idx + 1] * inverse + color[1] * alpha);
  png.data[idx + 2] = Math.round(png.data[idx + 2] * inverse + color[2] * alpha);
  png.data[idx + 3] = 255;
}

function drawFilledRect(png, rect, color, alpha = 1) {
  const x1 = Math.max(0, Math.floor(rect.x));
  const y1 = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(png.width, Math.ceil(rect.x + rect.width));
  const y2 = Math.min(png.height, Math.ceil(rect.y + rect.height));
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      blendPixel(png, x, y, color, alpha);
    }
  }
}

function drawRectStroke(png, rect, color, thickness = 4) {
  drawFilledRect(png, { x: rect.x, y: rect.y, width: rect.width, height: thickness }, color, 1);
  drawFilledRect(png, { x: rect.x, y: rect.y + rect.height - thickness, width: rect.width, height: thickness }, color, 1);
  drawFilledRect(png, { x: rect.x, y: rect.y, width: thickness, height: rect.height }, color, 1);
  drawFilledRect(png, { x: rect.x + rect.width - thickness, y: rect.y, width: thickness, height: rect.height }, color, 1);
}

function writeAnnotatedPngEvidence(outDir, screenshotAbs, annotationAbs, crop, rects, size) {
  const PNG = loadPngModule();
  if (!PNG) return false;

  const source = PNG.sync.read(fs.readFileSync(screenshotAbs));
  const target = new PNG({ width: crop.width, height: crop.height });

  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const sourceX = crop.x + x;
      const sourceY = crop.y + y;
      const targetIdx = (target.width * y + x) << 2;
      if (sourceX >= source.width || sourceY >= source.height) {
        target.data[targetIdx] = 255;
        target.data[targetIdx + 1] = 255;
        target.data[targetIdx + 2] = 255;
        target.data[targetIdx + 3] = 255;
        continue;
      }
      const sourceIdx = (source.width * sourceY + sourceX) << 2;
      target.data[targetIdx] = source.data[sourceIdx];
      target.data[targetIdx + 1] = source.data[sourceIdx + 1];
      target.data[targetIdx + 2] = source.data[sourceIdx + 2];
      target.data[targetIdx + 3] = source.data[sourceIdx + 3];
    }
  }

  rects.slice(0, 8).forEach((item, index) => {
    const rect = {
      x: Math.max(0, Math.min(size.width - 1, item.rect.x)) - crop.x,
      y: Math.max(0, Math.min(size.height - 1, item.rect.y)) - crop.y,
      width: Math.max(1, Math.min(size.width, item.rect.width)),
      height: Math.max(1, Math.min(size.height, item.rect.height)),
    };
    drawFilledRect(target, rect, [220, 38, 38], 0.14);
    drawRectStroke(target, rect, [220, 38, 38], 4);
    drawFilledRect(target, {
      x: rect.x,
      y: Math.max(0, rect.y - 24),
      width: Math.min(target.width - rect.x, 34),
      height: 22,
    }, [220, 38, 38], 1);
    drawFilledRect(target, {
      x: rect.x + 10,
      y: Math.max(0, rect.y - 18),
      width: 6 + (index > 8 ? 4 : 0),
      height: 10,
    }, [255, 255, 255], 1);
  });

  fs.writeFileSync(annotationAbs, PNG.sync.write(target));
  return true;
}

function rectFromExample(example) {
  const rect = example?.rect || example?.location?.rect || example?.mismatchBounds || null;
  if (!rect || !Number.isFinite(Number(rect.x)) || !Number.isFinite(Number(rect.y))) return null;
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    x: Math.round(Number(rect.x)),
    y: Math.round(Number(rect.y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function issueLocationSummary(finding) {
  const examples = finding.examples || [];
  for (const example of examples) {
    const location = example.location || example.locations?.[0] || null;
    if (location) {
      return {
        section: location.nearestHeading || location.sectionLabel || location.sectionSelector || "Page",
        sectionSelector: location.sectionSelector || null,
        selector: location.selector || example.selector || null,
        textSnippet: location.textSnippet || example.text || null,
      };
    }
    if (example.selector || example.text || example.id) {
      return {
        section: "Page",
        sectionSelector: null,
        selector: example.selector || null,
        textSnippet: example.text || example.id || null,
      };
    }
  }
  return {
    section: finding.affectedEnvironments?.[0]?.route?.label || "Page",
    sectionSelector: null,
    selector: null,
    textSnippet: null,
  };
}

function writeAnnotatedEvidence(outDir, findings) {
  ensureDir(path.join(outDir, "annotations"));

  for (const finding of findings) {
    finding.location = issueLocationSummary(finding);
    const screenshotRel = finding.evidence?.liveScreenshot || finding.evidence?.liveScreenshots?.[0];
    if (!screenshotRel) continue;
    const screenshotAbs = path.join(outDir, screenshotRel);
    if (!fs.existsSync(screenshotAbs)) continue;

    const rects = [];
    for (const example of finding.examples || []) {
      const direct = rectFromExample(example);
      if (direct) {
        rects.push({ rect: direct, label: example.text || example.selector || finding.title });
      }
      for (const nested of example.locations || []) {
        const nestedRect = rectFromExample({ location: nested });
        if (nestedRect) rects.push({ rect: nestedRect, label: nested.textSnippet || nested.selector || finding.title });
      }
      if (rects.length >= 8) break;
    }
    if (!rects.length) continue;

    let size;
    try {
      size = readPngSize(screenshotAbs);
    } catch {
      continue;
    }

    const padding = Number.isFinite(Number(finding.evidence?.cropPadding)) ? Number(finding.evidence.cropPadding) : 96;
    const viewportHeight = Number(finding.affectedEnvironments?.[0]?.viewport?.height) || 900;
    const maxSectionCropHeight = Math.min(size.height, Math.max(520, viewportHeight));
    const firstBounds = rects.slice(0, 8).reduce(
      (bounds, item) => ({
        minX: Math.min(bounds.minX, item.rect.x),
        minY: Math.min(bounds.minY, item.rect.y),
        maxX: Math.max(bounds.maxX, item.rect.x + item.rect.width),
        maxY: Math.max(bounds.maxY, item.rect.y + item.rect.height),
      }),
      { minX: size.width, minY: size.height, maxX: 0, maxY: 0 }
    );
    const rectGroups = firstBounds.maxY - firstBounds.minY > maxSectionCropHeight * 1.25
      ? rects.slice(0, 6).map((item) => [item])
      : [rects.slice(0, 8)];

    const annotationRels = [];
    let primaryCrop = null;

    for (const [groupIndex, group] of rectGroups.entries()) {
      const rawBounds = group.reduce(
        (bounds, item) => ({
          minX: Math.min(bounds.minX, item.rect.x),
          minY: Math.min(bounds.minY, item.rect.y),
          maxX: Math.max(bounds.maxX, item.rect.x + item.rect.width),
          maxY: Math.max(bounds.maxY, item.rect.y + item.rect.height),
        }),
        { minX: size.width, minY: size.height, maxX: 0, maxY: 0 }
      );
      const crop = {
        x: Math.max(0, Math.floor(rawBounds.minX - padding)),
        y: Math.max(0, Math.floor(rawBounds.minY - padding)),
        width: Math.min(size.width, Math.ceil(rawBounds.maxX + padding)) - Math.max(0, Math.floor(rawBounds.minX - padding)),
        height: Math.min(size.height, Math.ceil(rawBounds.maxY + padding)) - Math.max(0, Math.floor(rawBounds.minY - padding)),
      };
      const minCropHeight = Math.min(size.height, 360);
      const minCropWidth = Math.min(size.width, 520);
      if (crop.height < minCropHeight) {
        const extra = minCropHeight - crop.height;
        crop.y = Math.max(0, Math.floor(crop.y - extra / 2));
        crop.height = Math.min(size.height - crop.y, minCropHeight);
      }
      if (crop.width < minCropWidth) {
        const extra = minCropWidth - crop.width;
        crop.x = Math.max(0, Math.floor(crop.x - extra / 2));
        crop.width = Math.min(size.width - crop.x, minCropWidth);
      }
      if (!primaryCrop) primaryCrop = crop;

      const suffix = groupIndex === 0 ? "" : `-${groupIndex + 1}`;
      const annotationRel = path.join("annotations", `${finding.id}-${slug(finding.title)}${suffix}.png`);
      const annotationAbs = path.join(outDir, annotationRel);
      let wroteAnnotation = writeAnnotatedPngEvidence(outDir, screenshotAbs, annotationAbs, crop, group, size);
      let finalAnnotationRel = annotationRel;

      if (!wroteAnnotation) {
        finalAnnotationRel = path.join("annotations", `${finding.id}-${slug(finding.title)}${suffix}.svg`);
        const fallbackAbs = path.join(outDir, finalAnnotationRel);
        const screenshotDataUri = `data:image/png;base64,${fs.readFileSync(screenshotAbs).toString("base64")}`;
        const overlays = group.map((item, index) => {
          const rect = {
            x: Math.max(0, Math.min(size.width - 1, item.rect.x)),
            y: Math.max(0, Math.min(size.height - 1, item.rect.y)),
            width: Math.max(1, Math.min(size.width, item.rect.width)),
            height: Math.max(1, Math.min(size.height, item.rect.height)),
          };
          const localX = rect.x - crop.x;
          const localY = rect.y - crop.y;
          const labelY = Math.max(18, localY - 8);
          const label = `${index + 1}. ${(item.label || finding.title).slice(0, 90)}`;
          return `
            <rect x="${localX}" y="${localY}" width="${rect.width}" height="${rect.height}" fill="rgba(220,38,38,0.12)" stroke="#dc2626" stroke-width="4" rx="6"/>
            <rect x="${localX}" y="${labelY - 18}" width="${Math.min(crop.width - localX, Math.max(180, label.length * 7))}" height="22" fill="#dc2626" rx="4"/>
            <text x="${localX + 7}" y="${labelY - 3}" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="13">${htmlAttr(label)}</text>`;
        }).join("");

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}" viewBox="0 0 ${crop.width} ${crop.height}">
          <title>${htmlAttr(finding.id)} ${htmlAttr(finding.title)}</title>
          <image href="${screenshotDataUri}" x="${-crop.x}" y="${-crop.y}" width="${size.width}" height="${size.height}"/>
          ${overlays}
        </svg>`;
        fs.writeFileSync(fallbackAbs, svg);
      }

      annotationRels.push(finalAnnotationRel);
    }

    finding.evidence = {
      ...(finding.evidence || {}),
      annotatedScreenshot: annotationRels[0],
      annotatedScreenshots: annotationRels,
      evidenceCrop: primaryCrop,
    };
  }
}

function environmentsText(finding) {
  return (finding.affectedEnvironments || [])
    .map((env) => `${env.route?.label || "Home"} / ${env.browser} / ${env.device} / ${env.viewport?.width}x${env.viewport?.height}`)
    .join(", ");
}

function developerTicketFor(finding) {
  const location = finding.location || issueLocationSummary(finding);
  const evidence = finding.evidence || {};
  const lines = [
    `# ${finding.id} ${finding.title}`,
    "",
    `- Severity: ${finding.severity}`,
    `- Confidence: ${finding.confidence || "medium"}`,
    `- Category: ${finding.category}`,
    `- Source: ${finding.source || "rule"}`,
    `- State: ${finding.state || "page-load"}`,
    `- Section: ${location.section || finding.section || "Page"}`,
    location.selector ? `- Selector: \`${location.selector}\`` : null,
    location.textSnippet ? `- Text/content: ${location.textSnippet}` : null,
    `- Affected environments: ${environmentsText(finding) || "Not specified"}`,
    evidence.annotatedScreenshot ? `- Evidence: ${evidence.annotatedScreenshot}` : evidence.liveScreenshot ? `- Evidence: ${evidence.liveScreenshot}` : null,
    finding.designReference?.frameUrl ? `- Figma frame: ${finding.designReference.frameUrl}` : null,
    finding.designReference?.image ? `- Figma image: ${finding.designReference.image}` : null,
    "",
    "## Expected",
    finding.expected || "Expected behavior was not specified.",
    "",
    "## Actual",
    finding.actual || "Actual behavior was not specified.",
    "",
    "## Suggested Fix",
    finding.suggestedFix || "Inspect the affected section and align implementation with the design/QA rule.",
    "",
    "## Reproduction",
    ...((finding.reproduction?.steps || []).map((step, index) => `${index + 1}. ${step}`)),
  ].filter(Boolean);
  return lines.join("\n");
}

function enrichFindingsForReview(findings) {
  return findings.map((finding) => {
    const location = finding.location || issueLocationSummary(finding);
    const section = finding.section || location.section || "Page";
    const enriched = {
      ...finding,
      section,
      location,
      confidence: confidenceForFinding(finding),
      source: sourceForFinding(finding),
      state: stateForFinding(finding),
      designReference: finding.designReference || {
        frameUrl: finding.evidence?.figmaReference || null,
        image: finding.evidence?.figmaReferenceImage || null,
      },
    };
    enriched.developerTicket = developerTicketFor(enriched);
    return enriched;
  });
}

function writeDeveloperTickets(outDir, findings) {
  ensureDir(path.join(outDir, "tickets"));
  for (const finding of findings) {
    const rel = path.join("tickets", `${finding.id}-${slug(finding.title)}.md`);
    fs.writeFileSync(path.join(outDir, rel), finding.developerTicket || developerTicketFor(finding));
    finding.ticket = rel;
  }
}

function comparePngs(figmaPath, livePath, threshold = 40) {
  const figmaSize = readPngSize(figmaPath);
  const liveSize = readPngSize(livePath);
  let pixelDiff = null;

  try {
    const PNG = createRequire(path.join(process.cwd(), "package.json"))("pngjs").PNG;
    const figma = PNG.sync.read(fs.readFileSync(figmaPath));
    const live = PNG.sync.read(fs.readFileSync(livePath));
    const width = Math.min(figma.width, live.width);
    const height = Math.min(figma.height, live.height);
    let compared = 0;
    let mismatched = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const fi = (figma.width * y + x) << 2;
        const li = (live.width * y + x) << 2;
        const delta =
          Math.abs(figma.data[fi] - live.data[li]) +
          Math.abs(figma.data[fi + 1] - live.data[li + 1]) +
          Math.abs(figma.data[fi + 2] - live.data[li + 2]) +
          Math.abs(figma.data[fi + 3] - live.data[li + 3]);
        compared += 1;
        if (delta > threshold) {
          mismatched += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    pixelDiff = {
      comparedPixels: compared,
      mismatchedPixels: mismatched,
      mismatchRatio: compared ? mismatched / compared : 0,
      mismatchBounds:
        mismatched > 0
          ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
          : null,
    };
  } catch {
    pixelDiff = null;
  }

  return {
    figma: { path: figmaPath, ...figmaSize },
    live: { path: livePath, ...liveSize },
    sizeMatches: figmaSize.width === liveSize.width && figmaSize.height === liveSize.height,
    dimensionDelta: {
      width: liveSize.width - figmaSize.width,
      height: liveSize.height - figmaSize.height,
    },
    pixelDiffAvailable: Boolean(pixelDiff),
    pixelDiff,
  };
}

function classifyVisualDiff(diff) {
  const ratio = diff.pixelDiff?.mismatchRatio || 0;
  const bounds = diff.pixelDiff?.mismatchBounds || null;
  const delta = diff.dimensionDelta || { width: 0, height: 0 };
  if (Math.abs(delta.width) > 24 || Math.abs(delta.height) > 120) {
    return {
      type: "layout mismatch",
      category: "design parity",
      summary: `Live page dimensions differ from Figma by ${delta.width}x${delta.height}px.`,
    };
  }
  if (bounds && bounds.height < 120 && bounds.width > 180) {
    return {
      type: "typography or content mismatch",
      category: "design parity",
      summary: "Mismatch is concentrated in a shallow horizontal region, often caused by text, type, or content differences.",
    };
  }
  if (bounds && bounds.width < 160 && bounds.height < 160) {
    return {
      type: "color or component mismatch",
      category: "design parity",
      summary: "Mismatch is localized to a small component-sized region.",
    };
  }
  if (ratio > 0.18) {
    return {
      type: "layout/content mismatch",
      category: "design parity",
      summary: "Large regions differ between live and Figma, suggesting layout, content, or media drift.",
    };
  }
  return {
    type: "visual mismatch",
    category: "design parity",
    summary: "Live and Figma screenshots differ above the configured tolerance.",
  };
}

async function collectAccessibility(page) {
  return page.evaluate(() => {
    const issues = [];
    const cssPath = (node) => {
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const id = current.id ? `#${current.id}` : "";
        const classes = Array.from(current.classList || [])
          .slice(0, 2)
          .map((className) => `.${className}`)
          .join("");
        parts.unshift(`${current.tagName.toLowerCase()}${id}${classes}`);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const rectFor = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        viewportX: Math.round(rect.x),
        viewportY: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right + window.scrollX),
      };
    };
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (node) => (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
    const locationFor = (node) => {
      const region = node.closest("section,main,header,footer,nav,article,aside,[role='region'],[aria-label],[data-framer-name]") || node.parentElement;
      const heading = region ? region.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']") : null;
      return {
        selector: cssPath(node),
        sectionSelector: region ? cssPath(region) : null,
        sectionLabel: region ? (region.getAttribute("aria-label") || region.getAttribute("data-framer-name") || region.getAttribute("id") || region.tagName.toLowerCase()) : null,
        nearestHeading: heading ? textOf(heading).slice(0, 120) : null,
        textSnippet: textOf(node).slice(0, 140),
        rect: isVisible(node) ? rectFor(node) : null,
      };
    };
    const accessibleName = (node) => {
      const labelledBy = node.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelText = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((labelNode) => textOf(labelNode))
          .join(" ")
          .trim();
        if (labelText) return labelText;
      }
      const aria = node.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const title = node.getAttribute("title");
      if (title && title.trim()) return title.trim();
      const text = textOf(node);
      if (text) return text;
      const imageAlt = Array.from(node.querySelectorAll("img[alt]"))
        .map((img) => img.getAttribute("alt"))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (imageAlt) return imageAlt;
      const value = node.getAttribute("value");
      if ((node.tagName || "").toLowerCase() === "input" && value && value.trim()) return value.trim();
      return "";
    };

    const htmlLang = document.documentElement.getAttribute("lang");
    if (!htmlLang || !htmlLang.trim()) {
      issues.push({
        title: "Page language is not declared",
        fingerprint: "accessibility:missing-html-lang",
        severity: "medium",
        category: "accessibility",
        expected: "The html element should declare the page language for assistive technology and translation tools.",
        actual: "The html element has no lang attribute.",
        suggestedFix: "Set a language on the root element, for example <html lang=\"en\">.",
        examples: [{ selector: "html" }],
      });
    }

    const pageTitle = (document.title || "").trim();
    if (!pageTitle) {
      issues.push({
        title: "Page title is missing",
        fingerprint: "accessibility:missing-title",
        severity: "medium",
        category: "accessibility",
        expected: "Each page should have a concise title that describes the current view.",
        actual: "The document title is empty.",
        suggestedFix: "Add a meaningful <title> value for this route.",
        examples: [{ selector: "head > title" }],
      });
    }

    const viewportMeta = document.querySelector("meta[name='viewport']");
    const viewportContent = viewportMeta ? viewportMeta.getAttribute("content") || "" : "";
    if (!viewportMeta || !/width\s*=\s*device-width/i.test(viewportContent)) {
      issues.push({
        title: "Responsive viewport meta is missing or incomplete",
        fingerprint: "accessibility:viewport-meta",
        severity: "high",
        category: "responsive layout",
        expected: "Responsive pages should include a viewport meta tag with width=device-width.",
        actual: viewportMeta ? `Viewport meta content is "${viewportContent}".` : "No viewport meta tag was found.",
        suggestedFix: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> in the document head.",
        examples: [{ selector: "head > meta[name='viewport']", content: viewportContent || null }],
      });
    }

    const ids = new Map();
    document.querySelectorAll("[id]").forEach((node) => {
      const id = node.getAttribute("id");
      if (!id) return;
      if (!ids.has(id)) ids.set(id, []);
      ids.get(id).push(node);
    });
    const duplicateIds = Array.from(ids.entries())
      .filter(([, nodes]) => nodes.length > 1)
      .slice(0, 8)
      .map(([id, nodes]) => ({
        id,
        count: nodes.length,
        selectors: nodes.slice(0, 3).map((node) => cssPath(node)),
        locations: nodes.slice(0, 3).map((node) => locationFor(node)),
      }));
    if (duplicateIds.length > 0) {
      issues.push({
        title: "Duplicate element IDs detected",
        fingerprint: "accessibility:duplicate-id",
        severity: "medium",
        category: "accessibility",
        expected: "Each id value should be unique so labels, anchors, and aria references resolve reliably.",
        actual: `${duplicateIds.length} duplicate id value(s) were found.`,
        suggestedFix: "Make duplicated ids unique and update any label, aria-labelledby, aria-describedby, or anchor references.",
        examples: duplicateIds,
      });
    }

    document.querySelectorAll("img").forEach((img, index) => {
      if (!img.hasAttribute("alt")) {
        issues.push({
          title: "Image is missing alt text",
          fingerprint: "accessibility:missing-image-alt",
          severity: "medium",
          category: "accessibility",
          expected: "Informative images should include alt text or an empty alt attribute when decorative.",
          actual: `Image ${index + 1} has no alt attribute.`,
          suggestedFix: "Add descriptive alt text, or alt=\"\" for decorative images.",
          examples: [
            {
              selector: cssPath(img),
              src: img.currentSrc || img.src || null,
              location: locationFor(img),
            },
          ],
        });
      }
    });

    const unnamedInteractive = Array.from(document.querySelectorAll("a[href], button, [role='button'], [role='link'], input[type='button'], input[type='submit'], input[type='reset']"))
      .filter((node) => isVisible(node) && !accessibleName(node))
      .slice(0, 10)
      .map((node) => ({
        selector: cssPath(node),
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || null,
        href: node.getAttribute("href") || null,
        rect: rectFor(node),
        location: locationFor(node),
      }));
    if (unnamedInteractive.length > 0) {
      issues.push({
        title: "Interactive element has no accessible name",
        fingerprint: "accessibility:unnamed-interactive",
        severity: "high",
        category: "accessibility",
        expected: "Every link, button, and role-based interactive control should expose a clear accessible name.",
        actual: `${unnamedInteractive.length} visible interactive element(s) have no text, aria-label, title, or image alt text.`,
        suggestedFix: "Add visible text or a programmatic label with aria-label/aria-labelledby for icon-only controls.",
        examples: unnamedInteractive,
      });
    }

    const smallTouchTargets = Array.from(document.querySelectorAll("button, a[href], input:not([type='hidden']), select, textarea, [role='button'], [role='link'], [tabindex]"))
      .filter((node) => isVisible(node))
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ node, rect }) => {
        const type = (node.getAttribute("type") || "").toLowerCase();
        if (["checkbox", "radio"].includes(type)) {
          const label = node.closest("label");
          if (label) {
            const labelRect = label.getBoundingClientRect();
            if (labelRect.width >= 44 && labelRect.height >= 44) return false;
          }
        }
        return rect.width > 0 && rect.height > 0;
      })
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44))
      .slice(0, 10)
      .map(({ node }) => ({
        selector: cssPath(node),
        text: accessibleName(node).slice(0, 90) || textOf(node).slice(0, 90),
        rect: rectFor(node),
        location: locationFor(node),
      }));
    if (smallTouchTargets.length > 0) {
      issues.push({
        title: "Touch target is smaller than recommended",
        fingerprint: "accessibility:small-touch-target",
        severity: "medium",
        category: "interaction",
        expected: "Primary interactive targets should be at least 44x44 CSS pixels or have enough spacing to tap safely.",
        actual: `${smallTouchTargets.length} visible interactive target(s) are smaller than 44x44 CSS pixels.`,
        suggestedFix: "Increase target dimensions, padding, or surrounding tap area for the listed controls at this breakpoint.",
        examples: smallTouchTargets,
      });
    }

    document.querySelectorAll("input, select, textarea").forEach((control, index) => {
      const id = control.getAttribute("id");
      const hasLabel = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || control.closest("label");
      const hasAria = control.getAttribute("aria-label") || control.getAttribute("aria-labelledby");
      if (!hasLabel && !hasAria && control.getAttribute("type") !== "hidden") {
        issues.push({
          title: "Form control has no accessible label",
          fingerprint: "accessibility:unlabeled-form-control",
          severity: "high",
          category: "accessibility",
          expected: "Every form control should have a visible or programmatic label.",
          actual: `Form control ${index + 1} has no label or aria label.`,
          suggestedFix: "Associate a label element or add aria-label/aria-labelledby.",
          examples: [
            {
              selector: cssPath(control),
              type: control.getAttribute("type") || control.tagName.toLowerCase(),
              placeholder: control.getAttribute("placeholder") || null,
              location: locationFor(control),
            },
          ],
        });
      }
    });

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((heading) => Number(heading.tagName.slice(1)));
    for (let i = 1; i < headings.length; i += 1) {
      if (headings[i] - headings[i - 1] > 1) {
        issues.push({
          title: "Heading level is skipped",
          fingerprint: "accessibility:skipped-heading-level",
          severity: "low",
          category: "accessibility",
          expected: "Heading levels should progress without skipping levels.",
          actual: `Heading jumps from h${headings[i - 1]} to h${headings[i]}.`,
          suggestedFix: "Adjust heading levels to preserve document structure.",
          examples: [{ previous: `h${headings[i - 1]}`, current: `h${headings[i]}` }],
        });
        break;
      }
    }

    return issues;
  });
}

async function collectLayoutIssues(page) {
  return page.evaluate(() => {
    const issues = [];
    const cssPath = (node) => {
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const id = current.id ? `#${current.id}` : "";
        const classes = Array.from(current.classList || [])
          .slice(0, 2)
          .map((className) => `.${className}`)
          .join("");
        parts.unshift(`${current.tagName.toLowerCase()}${id}${classes}`);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const rectFor = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        viewportX: Math.round(rect.x),
        viewportY: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right + window.scrollX),
      };
    };
    const textOf = (node) => (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
    const locationFor = (node) => {
      const region = node.closest("section,main,header,footer,nav,article,aside,[role='region'],[aria-label],[data-framer-name]") || node.parentElement;
      const heading = region ? region.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']") : null;
      return {
        selector: cssPath(node),
        sectionSelector: region ? cssPath(region) : null,
        sectionLabel: region ? (region.getAttribute("aria-label") || region.getAttribute("data-framer-name") || region.getAttribute("id") || region.tagName.toLowerCase()) : null,
        nearestHeading: heading ? textOf(heading).slice(0, 120) : null,
        textSnippet: textOf(node).slice(0, 140),
        rect: rectFor(node),
      };
    };

    const overflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) {
      const examples = Array.from(document.querySelectorAll("body *"))
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter((item) => item.rect.width > 0 && item.rect.right > window.innerWidth + 2)
        .sort((a, b) => b.rect.right - a.rect.right)
        .slice(0, 5)
        .map((item) => ({
          selector: cssPath(item.node),
          text: textOf(item.node).slice(0, 90),
          rect: rectFor(item.node),
          location: locationFor(item.node),
        }));
      issues.push({
        title: "Page has horizontal overflow",
        fingerprint: "layout:horizontal-overflow",
        severity: overflow > 40 ? "high" : "medium",
        category: "responsive layout",
        expected: "The page should fit the viewport without horizontal scrolling.",
        actual: `Document is ${overflow}px wider than the viewport.`,
        suggestedFix: "Inspect fixed-width containers, large media, and negative margins at this breakpoint.",
        examples,
      });
    }

    const tinyText = Array.from(document.querySelectorAll("body *"))
      .map((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          node,
          rect,
          fontSize: Number.parseFloat(style.fontSize),
          text: (node.innerText || node.textContent || "").trim().replace(/\s+/g, " "),
        };
      })
      .filter((item) => item.rect.width > 0 && item.rect.height > 0 && item.fontSize < 12 && item.text.length > 0);
    if (tinyText.length > 0) {
      issues.push({
        title: "Text below readable size detected",
        fingerprint: "layout:tiny-text",
        severity: "low",
        category: "responsive layout",
        expected: "Body and control text should remain readable at the current viewport.",
        actual: `${tinyText.length} visible text element(s) are below 12px.`,
        suggestedFix: "Raise small text styles or apply responsive typography tokens.",
        examples: tinyText.slice(0, 8).map((item) => ({
          selector: cssPath(item.node),
          text: item.text.slice(0, 90),
          fontSize: `${item.fontSize}px`,
          rect: rectFor(item.node),
          location: locationFor(item.node),
        })),
      });
    }

    const clippedTargets = Array.from(document.querySelectorAll("button,a,input,select,textarea,[role='button']"))
      .map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0 && (item.rect.right < 0 || item.rect.left > window.innerWidth));
    if (clippedTargets.length > 0) {
      issues.push({
        title: "Interactive elements render outside the horizontal viewport",
        fingerprint: "layout:horizontal-clipped-interactive",
        severity: "high",
        category: "responsive layout",
        expected: "Interactive controls should remain horizontally visible and reachable.",
        actual: `${clippedTargets.length} interactive element(s) are clipped beyond the horizontal viewport.`,
        suggestedFix: "Check responsive positioning, sticky elements, and menu layout at this breakpoint.",
        examples: clippedTargets.slice(0, 8).map((item) => ({
          selector: cssPath(item.node),
          text: (item.node.innerText || item.node.getAttribute("aria-label") || item.node.getAttribute("href") || "").trim().slice(0, 90),
          rect: rectFor(item.node),
          location: locationFor(item.node),
        })),
      });
    }

    return issues;
  });
}

async function collectContrastIssues(page) {
  return page.evaluate(() => {
    const issues = [];
    const cssPath = (node) => {
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const id = current.id ? `#${current.id}` : "";
        const classes = Array.from(current.classList || [])
          .slice(0, 2)
          .map((className) => `.${className}`)
          .join("");
        parts.unshift(`${current.tagName.toLowerCase()}${id}${classes}`);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const rgb = (value) => {
      const match = String(value).match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const [r, g, b, a = 1] = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      if ([r, g, b].some((channel) => Number.isNaN(channel)) || a === 0) return null;
      return [r, g, b];
    };
    const luminance = ([r, g, b]) => {
      const values = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const contrast = (fg, bg) => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const backgroundFor = (node) => {
      let current = node;
      while (current && current.nodeType === 1) {
        const color = rgb(getComputedStyle(current).backgroundColor);
        if (color) return color;
        current = current.parentElement;
      }
      return [255, 255, 255];
    };
    const rectFor = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        viewportX: Math.round(rect.x),
        viewportY: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right + window.scrollX),
      };
    };
    const textOf = (node) => (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ");
    const locationFor = (node) => {
      const region = node.closest("section,main,header,footer,nav,article,aside,[role='region'],[aria-label],[data-framer-name]") || node.parentElement;
      const heading = region ? region.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']") : null;
      return {
        selector: cssPath(node),
        sectionSelector: region ? cssPath(region) : null,
        sectionLabel: region ? (region.getAttribute("aria-label") || region.getAttribute("data-framer-name") || region.getAttribute("id") || region.tagName.toLowerCase()) : null,
        nearestHeading: heading ? textOf(heading).slice(0, 120) : null,
        textSnippet: textOf(node).slice(0, 140),
        rect: rectFor(node),
      };
    };
    const hasDirectText = (node) =>
      Array.from(node.childNodes || []).some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0);
    const hasVisibleTextChild = (node) =>
      Array.from(node.children || []).some((child) => {
        const rect = child.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && textOf(child).length > 0;
      });
    const isMeaningfulTextNode = (node) => {
      const tag = (node.tagName || "").toLowerCase();
      if (["script", "style", "noscript", "template", "svg"].includes(tag)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return false;
      if (!textOf(node)) return false;
      return hasDirectText(node) || !hasVisibleTextChild(node) || ["button", "a", "label", "summary"].includes(tag);
    };

    const failures = Array.from(document.querySelectorAll("body *"))
      .map((node) => {
        if (!isMeaningfulTextNode(node)) return null;
        const style = getComputedStyle(node);
        const text = textOf(node);
        const foreground = rgb(style.color);
        const background = backgroundFor(node);
        if (!foreground || !background) return null;
        const fontSize = Number.parseFloat(style.fontSize);
        const ratio = contrast(foreground, background);
        const required = fontSize >= 18 || (fontSize >= 14 && Number.parseInt(style.fontWeight, 10) >= 600) ? 3 : 4.5;
        if (ratio >= required) return null;
        return {
          selector: cssPath(node),
          text: text.slice(0, 90),
          ratio: Number(ratio.toFixed(2)),
          required,
          fontSize: `${fontSize}px`,
          color: style.color,
          backgroundColor: `rgb(${background.map((channel) => Math.round(channel)).join(", ")})`,
          rawBackgroundColor: getComputedStyle(node).backgroundColor,
          rect: rectFor(node),
          location: locationFor(node),
        };
      })
      .filter(Boolean)
      .slice(0, 10);

    if (failures.length > 0) {
      issues.push({
        title: "Text contrast may fail WCAG thresholds",
        fingerprint: "accessibility:contrast",
        severity: "medium",
        category: "accessibility",
        expected: "Text should meet WCAG contrast thresholds against its effective background.",
        actual: `${failures.length} sampled visible text element(s) have insufficient contrast.`,
        suggestedFix: "Increase foreground/background contrast for the listed text styles, especially small labels and secondary copy.",
        examples: failures,
      });
    }

    return issues;
  });
}

async function collectPerformanceIssues(page) {
  return page.evaluate(() => {
    const issues = [];
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)]));
    const resources = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.transferSize > 400000 || entry.encodedBodySize > 400000)
      .sort((a, b) => (b.transferSize || b.encodedBodySize) - (a.transferSize || a.encodedBodySize))
      .slice(0, 8)
      .map((entry) => ({
        url: entry.name,
        transferKb: Math.round((entry.transferSize || 0) / 1024),
        encodedKb: Math.round((entry.encodedBodySize || 0) / 1024),
        type: entry.initiatorType,
      }));

    if (navigation && navigation.duration > 6000) {
      issues.push({
        title: "Page load duration is high",
        fingerprint: "performance:slow-navigation",
        severity: navigation.duration > 10000 ? "high" : "medium",
        category: "performance",
        expected: "The page should become ready quickly enough for QA interactions and user navigation.",
        actual: `Navigation duration was ${Math.round(navigation.duration)}ms.`,
        suggestedFix: "Reduce blocking scripts, compress large media, and review third-party script impact.",
        examples: [{ durationMs: Math.round(navigation.duration), firstPaintMs: paint["first-paint"] || null, contentfulPaintMs: paint["first-contentful-paint"] || null }],
      });
    }

    if (resources.length > 0) {
      issues.push({
        title: "Large assets detected",
        fingerprint: "performance:large-assets",
        severity: resources.some((resource) => resource.transferKb > 1000 || resource.encodedKb > 1000) ? "medium" : "low",
        category: "performance",
        expected: "Images, scripts, and fonts should be sized for the tested breakpoint.",
        actual: `${resources.length} resource(s) exceed 400KB transfer or encoded size.`,
        suggestedFix: "Compress or resize large media, split large JavaScript bundles, and serve breakpoint-appropriate images.",
        examples: resources,
      });
    }

    return issues;
  });
}

async function collectInteractionIssues(page, checks) {
  const issues = [];
  const requested = new Set(checks || ["hover", "scroll", "focus", "click", "forms", "sticky"]);

  if (requested.has("scroll")) {
    const scrollResult = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollTo(0, Math.min(700, document.documentElement.scrollHeight));
      return { before, after: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight };
    });
    if (scrollResult.height > scrollResult.viewport && scrollResult.after === scrollResult.before) {
      issues.push({
        title: "Page does not scroll despite overflowing content",
        fingerprint: "interaction:scroll-blocked",
        severity: "high",
        category: "interaction",
        expected: "Users should be able to scroll through content taller than the viewport.",
        actual: "Programmatic scroll did not move the page.",
        suggestedFix: "Check body/html overflow rules and fixed containers.",
      });
    }
  }

  if (requested.has("focus")) {
    const focusableCount = await page.locator("a,button,input,select,textarea,[tabindex]:not([tabindex='-1'])").count();
    if (focusableCount === 0) {
      issues.push({
        title: "No keyboard-focusable controls found",
        fingerprint: "interaction:no-focusable-controls",
        severity: "medium",
        category: "interaction",
        expected: "Interactive pages should expose keyboard-focusable controls.",
        actual: "No focusable controls were found by the audit selector.",
        suggestedFix: "Use semantic buttons/links and avoid removing focusability from custom controls.",
      });
    } else {
      await page.keyboard.press("Tab");
      const activeTag = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
      if (!activeTag || activeTag === "BODY") {
        issues.push({
          title: "Keyboard focus is not visible on first tab stop",
          fingerprint: "interaction:first-tab-focus-missing",
          severity: "medium",
          category: "interaction",
          expected: "Pressing Tab should move focus to a visible interactive element.",
          actual: "Focus stayed on the page body after pressing Tab.",
          suggestedFix: "Restore native focus order and visible focus states.",
        });
      }
    }
  }

  if (requested.has("forms")) {
    const requiredWithoutErrorText = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input[required],textarea[required],select[required]")).filter((node) => {
        const describedBy = node.getAttribute("aria-describedby");
        return !describedBy && !node.getAttribute("aria-errormessage");
      }).length;
    });
    if (requiredWithoutErrorText > 0) {
      issues.push({
        title: "Required fields lack error description hooks",
        fingerprint: "interaction:required-fields-without-error-hooks",
        severity: "low",
        category: "interaction",
        expected: "Required controls should expose helper or error text relationships.",
        actual: `${requiredWithoutErrorText} required control(s) lack aria-describedby or aria-errormessage.`,
        suggestedFix: "Connect helper/error text with aria-describedby or aria-errormessage.",
      });
    }
  }

  return issues;
}

function environment(browserName, viewport, userAgent, route) {
  return {
    browser: browserName,
    device: viewport.label,
    route: route ? { id: route.id, label: route.label, url: route.url } : null,
    viewport: { width: viewport.width, height: viewport.height },
    userAgent,
  };
}

function reproduction(config, runId, viewport, userAgent, browserName, steps, route) {
  return {
    url: route?.url || config.url,
    route: route ? { id: route.id, label: route.label } : null,
    runId,
    timestamp: new Date().toISOString(),
    userAgent,
    browser: browserName,
    viewport: { width: viewport.width, height: viewport.height },
    steps,
  };
}

function dedupeFindings(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    const key = finding.fingerprint || [finding.title, finding.severity, finding.category, finding.expected, finding.suggestedFix].join("::");

    if (!grouped.has(key)) {
      grouped.set(key, {
        ...finding,
        affectedEnvironments: [...(finding.affectedEnvironments || [])],
        actualDetails: [finding.actual].filter(Boolean),
        examples: [...(finding.examples || [])],
        evidence: {
          ...(finding.evidence || {}),
          liveScreenshots: finding.evidence?.liveScreenshot ? [finding.evidence.liveScreenshot] : [],
        },
        occurrenceCount: 1,
      });
      continue;
    }

    const existing = grouped.get(key);
    existing.affectedEnvironments.push(...(finding.affectedEnvironments || []));
    existing.occurrenceCount += 1;
    if (finding.actual && !existing.actualDetails.includes(finding.actual)) {
      existing.actualDetails.push(finding.actual);
    }
    for (const example of finding.examples || []) {
      const serialized = JSON.stringify(example);
      if (!existing.examples.some((existingExample) => JSON.stringify(existingExample) === serialized)) {
        existing.examples.push(example);
      }
    }
    if (finding.evidence?.liveScreenshot && !existing.evidence.liveScreenshots.includes(finding.evidence.liveScreenshot)) {
      existing.evidence.liveScreenshots.push(finding.evidence.liveScreenshot);
    }
  }

  return Array.from(grouped.values()).map((finding, index) => ({
    ...finding,
    id: `F-${String(index + 1).padStart(3, "0")}`,
  }));
}

function evidenceFor(viewport, screenshotRel, diffRel = null) {
  return {
    liveScreenshot: screenshotRel,
    liveScreenshots: screenshotRel ? [screenshotRel] : [],
    figmaReference: viewport.figmaReference || null,
    figmaReferenceImage: viewport.figmaReferenceImage || null,
    diff: diffRel,
  };
}

async function collectRuntimeMetrics(page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paints = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)]));
    return {
      url: location.href,
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      navigation: navigation
        ? {
            durationMs: Math.round(navigation.duration),
            domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
            loadEventMs: Math.round(navigation.loadEventEnd),
            transferSize: navigation.transferSize || 0,
            encodedBodySize: navigation.encodedBodySize || 0,
          }
        : null,
      paints,
      resourceCount: performance.getEntriesByType("resource").length,
    };
  });
}

async function waitForVisualSettle(page, config = {}) {
  const settleMs = Number(config.animationSettleMs ?? config.visualSettleMs ?? 700);
  const stepDelay = Number(config.scrollSettleStepMs ?? 160);

  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch {
        // Ignore font readiness errors from cross-origin font loading.
      }
    }
    await Promise.all(
      Array.from(document.images || [])
        .filter((img) => !img.complete)
        .slice(0, 80)
        .map((img) =>
          new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 2500);
          })
        )
    );
  });

  if (config.triggerScrollAnimations !== false) {
    const pageInfo = await page.evaluate(() => ({
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      viewportHeight: window.innerHeight,
    }));
    const maxScroll = Math.max(0, pageInfo.height - pageInfo.viewportHeight);
    const step = Math.max(240, Math.floor(pageInfo.viewportHeight * 0.75));
    for (let y = 0; y <= maxScroll; y += step) {
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
      await page.waitForTimeout(stepDelay);
    }
    if (maxScroll > 0) {
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), maxScroll);
      await page.waitForTimeout(stepDelay);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  await page.waitForTimeout(settleMs);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function stateCaptureOptions(config) {
  const defaults = { hover: true, focus: true, scroll: true, openStates: true, forms: true, sticky: true, maxTargets: 6, maxScrollSections: 6 };
  if (config.stateCapture === false) {
    return { ...defaults, hover: false, focus: false, scroll: false, openStates: false, forms: false, sticky: false };
  }
  const raw = config.stateCapture || {};
  const interactions = new Set(config.interactions || []);
  return {
    ...defaults,
    ...raw,
    hover: raw.hover ?? (interactions.size ? interactions.has("hover") : defaults.hover),
    focus: raw.focus ?? (interactions.size ? interactions.has("focus") : defaults.focus),
    scroll: raw.scroll ?? (interactions.size ? interactions.has("scroll") : defaults.scroll),
    forms: raw.forms ?? (interactions.size ? interactions.has("forms") : defaults.forms),
    sticky: raw.sticky ?? (interactions.size ? interactions.has("sticky") : defaults.sticky),
    openStates: raw.openStates ?? (interactions.size ? interactions.has("click") : defaults.openStates),
    maxTargets: Number(raw.maxTargets || defaults.maxTargets),
    maxScrollSections: Number(raw.maxScrollSections || defaults.maxScrollSections),
  };
}

async function captureStateSnapshots(page, config, browserName, viewport, route, outDir) {
  const options = stateCaptureOptions(config);
  if (!Object.values(options).some(Boolean)) return [];
  ensureDir(path.join(outDir, "states"));
  const artifacts = [];
  const prefix = `${slug(browserName)}-${slug(viewport.key)}-${slug(route.id)}`;
  const save = async (name, metadata = {}) => {
    const rel = path.join("states", `${prefix}-${slug(name)}.png`);
    await page.screenshot({ path: path.join(outDir, rel), fullPage: false });
    artifacts.push({ name, screenshot: rel, ...metadata });
    return rel;
  };

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  await save("initial", { state: "initial" });

  if (options.scroll || options.sticky) {
    const scrollPoints = await page.evaluate((maxSections) => {
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      const viewportHeight = window.innerHeight;
      const maxY = Math.max(0, height - viewportHeight);
      if (!maxY) return [];
      const points = new Set([Math.min(maxY, Math.round(viewportHeight * 0.65)), maxY]);
      Array.from(document.querySelectorAll("main section, section, [data-section], header, footer"))
        .map((node) => Math.max(0, Math.round(node.getBoundingClientRect().top + window.scrollY - 80)))
        .filter((y) => y > 0 && y <= maxY)
        .slice(0, maxSections)
        .forEach((y) => points.add(y));
      return Array.from(points).sort((a, b) => a - b).slice(0, maxSections);
    }, options.maxScrollSections);
    for (const [index, y] of scrollPoints.entries()) {
      await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
      await page.waitForTimeout(220);
      await save(`scroll-${index + 1}`, { state: "scroll", scrollY: y });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
  }

  const targets = await page.evaluate((maxTargets) => {
    const cssPath = (node) => {
      const esc = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const id = current.id ? `#${esc(current.id)}` : "";
        const classes = Array.from(current.classList || []).slice(0, 2).map((className) => `.${esc(className)}`).join("");
        parts.unshift(`${current.tagName.toLowerCase()}${id}${classes}`);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    return Array.from(document.querySelectorAll("a,button,input,select,textarea,[role='button'],[tabindex]:not([tabindex='-1'])"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight;
      })
      .slice(0, maxTargets)
      .map((node, index) => ({
        index,
        selector: cssPath(node),
        text: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.value || "").trim().slice(0, 80),
      }));
  }, options.maxTargets);

  for (const target of targets) {
    const locator = page.locator(target.selector).first();
    if (options.hover) {
      try {
        await locator.hover({ timeout: 1200 });
        await page.waitForTimeout(180);
        await save(`hover-${target.index + 1}`, { state: "hover", selector: target.selector, text: target.text });
      } catch {
        // Opportunistic state capture should not create false failures.
      }
    }
    if (options.focus) {
      try {
        await locator.focus({ timeout: 1200 });
        await page.waitForTimeout(180);
        await save(`focus-${target.index + 1}`, { state: "focus", selector: target.selector, text: target.text });
      } catch {
        // Ignore non-focusable or unstable targets.
      }
    }
  }

  if (options.forms) {
    const formTarget = targets.find((target) => /input|textarea|select/.test(target.selector));
    if (formTarget) {
      try {
        await page.locator(formTarget.selector).first().focus({ timeout: 1200 });
        await page.waitForTimeout(180);
        await save("form-focus", { state: "form-focus", selector: formTarget.selector, text: formTarget.text });
      } catch {
        // Ignore unstable form state capture.
      }
    }
  }

  if (options.openStates) {
    const openTargets = targets
      .filter((target) => /menu|nav|open|toggle|more|filter|select|button/i.test(`${target.selector} ${target.text}`))
      .slice(0, 3);
    for (const target of openTargets) {
      try {
        await page.goto(route.url, { waitUntil: "networkidle", timeout: config.timeoutMs || 45000 });
        await waitForVisualSettle(page, { ...config, triggerScrollAnimations: false, animationSettleMs: 250 });
        await page.locator(target.selector).first().click({ timeout: 1500 });
        await page.waitForTimeout(260);
        await save(`open-${target.index + 1}`, { state: "open", selector: target.selector, text: target.text });
      } catch {
        // Click-open capture is intentionally conservative.
      }
    }
  }

  await page.goto(route.url, { waitUntil: "networkidle", timeout: config.timeoutMs || 45000 });
  await waitForVisualSettle(page, config);
  return artifacts;
}

async function captureSectionSnapshots(page, config, browserName, viewport, route, outDir) {
  const maxSections = Number(config.maxSectionSnapshots || config.stateCapture?.maxScrollSections || 6);
  ensureDir(path.join(outDir, "sections"));
  const prefix = `${slug(browserName)}-${slug(viewport.key)}-${slug(route.id)}`;
  const sections = await page.evaluate((limit) => {
    const cssPath = (node) => {
      const esc = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const id = current.id ? `#${esc(current.id)}` : "";
        const classes = Array.from(current.classList || []).slice(0, 2).map((className) => `.${esc(className)}`).join("");
        parts.unshift(`${current.tagName.toLowerCase()}${id}${classes}`);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const candidates = Array.from(document.querySelectorAll("main section, section, [data-section], header, footer, main > div"));
    const seen = new Set();
    return candidates
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        const heading = node.querySelector("h1,h2,h3,[aria-label]")?.innerText || node.getAttribute("aria-label") || node.getAttribute("data-section") || node.id || node.className || `Section ${index + 1}`;
        return {
          index,
          label: String(heading).trim().replace(/\s+/g, " ").slice(0, 90),
          selector: cssPath(node),
          y: Math.max(0, Math.round(rect.top + window.scrollY)),
          rect: { x: Math.round(rect.x + window.scrollX), y: Math.round(rect.y + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      })
      .filter((section) => section.rect.width > 40 && section.rect.height > 40 && !seen.has(section.y) && seen.add(section.y))
      .sort((a, b) => a.y - b.y)
      .slice(0, limit);
  }, maxSections);

  const artifacts = [];
  for (const section of sections) {
    const rel = path.join("sections", `${prefix}-section-${section.index + 1}.png`);
    await page.evaluate((scrollY) => window.scrollTo(0, Math.max(0, scrollY - 80)), section.y);
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(outDir, rel), fullPage: false });
    artifacts.push({ ...section, screenshot: rel });
  }
  fs.writeFileSync(path.join(outDir, "sections", `${prefix}-sections.json`), JSON.stringify(artifacts, null, 2));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  return artifacts;
}

function writeDiagnostics(outDir, browserName, viewport, route, diagnostics) {
  const diagnosticsRel = path.join("diagnostics", `${slug(browserName)}-${slug(viewport.key)}-${slug(route.id)}.json`);
  const diagnosticsAbs = path.join(outDir, diagnosticsRel);
  ensureDir(path.dirname(diagnosticsAbs));
  fs.writeFileSync(diagnosticsAbs, JSON.stringify(diagnostics, null, 2));
  return diagnosticsRel;
}

function scenariosFor(config, viewport, route) {
  const all = config.scenarios || config.flows || [];
  return all.filter((scenario) => {
    const routeAllowed = scenario.routes || scenario.route;
    if (routeAllowed) {
      const routeList = Array.isArray(routeAllowed) ? routeAllowed : [routeAllowed];
      const matchesRoute = routeList.map((item) => String(item).toLowerCase()).some((item) =>
        item === route.id.toLowerCase() || item === route.label.toLowerCase() || item === route.url.toLowerCase()
      );
      if (!matchesRoute) return false;
    }
    if (!scenario.viewports && !scenario.viewport && !scenario.devices && !scenario.device) return true;
    const allowed = scenario.viewports || scenario.viewport || scenario.devices || scenario.device;
    const list = Array.isArray(allowed) ? allowed : [allowed];
    return list.map((item) => String(item).toLowerCase()).includes(viewport.key.toLowerCase()) ||
      list.map((item) => String(item).toLowerCase()).includes(viewport.label.toLowerCase());
  });
}

async function runScenarioStep(page, step) {
  const action = step.action || step.type;
  const selector = step.selector;
  const timeout = step.timeoutMs || 5000;

  if (action === "goto") {
    await page.goto(step.url, { waitUntil: step.waitUntil || "networkidle", timeout });
    return;
  }
  if (action === "click") {
    await page.locator(selector).first().click({ timeout });
    return;
  }
  if (action === "hover") {
    await page.locator(selector).first().hover({ timeout });
    return;
  }
  if (action === "fill") {
    await page.locator(selector).first().fill(step.value || "", { timeout });
    return;
  }
  if (action === "press") {
    if (selector) {
      await page.locator(selector).first().press(step.key, { timeout });
    } else {
      await page.keyboard.press(step.key);
    }
    return;
  }
  if (action === "waitForSelector") {
    await page.locator(selector).first().waitFor({ state: step.state || "visible", timeout });
    return;
  }
  if (action === "waitForURL") {
    await page.waitForURL(step.url, { timeout });
    return;
  }
  if (action === "expectText") {
    const text = await page.locator(selector || "body").first().innerText({ timeout });
    if (!text.includes(step.text)) {
      throw new Error(`Expected text "${step.text}" was not found.`);
    }
    return;
  }
  if (action === "scroll") {
    await page.evaluate((scroll) => {
      window.scrollBy(scroll.x || 0, scroll.y || window.innerHeight);
    }, step);
    return;
  }
  if (action === "wait") {
    await page.waitForTimeout(step.ms || step.timeout || 500);
    return;
  }
  throw new Error(`Unsupported scenario action: ${action}`);
}

async function runScenarios(page, scenarios, browserName, viewport, route, outDir) {
  const results = [];
  ensureDir(path.join(outDir, "scenarios"));

  for (const scenario of scenarios) {
    const scenarioId = slug(scenario.id || scenario.name || `scenario-${results.length + 1}`);
    const result = {
      id: scenarioId,
      name: scenario.name || scenario.id || scenarioId,
      description: scenario.description || "",
      status: "passed",
      browser: browserName,
      device: viewport.label,
      route: { id: route.id, label: route.label, url: route.url },
      viewport: { width: viewport.width, height: viewport.height },
      steps: [],
      screenshot: null,
      error: null,
      durationMs: 0,
    };
    const startedAt = Date.now();

    try {
      for (let index = 0; index < (scenario.steps || []).length; index += 1) {
        const step = scenario.steps[index];
        const stepStartedAt = Date.now();
        await runScenarioStep(page, step);
        result.steps.push({
          index: index + 1,
          action: step.action || step.type,
          selector: step.selector || null,
          status: "passed",
          durationMs: Date.now() - stepStartedAt,
        });
      }
    } catch (error) {
      result.status = "failed";
      result.error = error.message;
      result.steps.push({
        index: result.steps.length + 1,
        status: "failed",
        error: error.message,
      });
    } finally {
      result.durationMs = Date.now() - startedAt;
      const screenshotRel = path.join("scenarios", `${slug(browserName)}-${slug(viewport.key)}-${slug(route.id)}-${scenarioId}.png`);
      const screenshotAbs = path.join(outDir, screenshotRel);
      try {
        await waitForVisualSettle(page, { ...scenario, triggerScrollAnimations: false, animationSettleMs: scenario.animationSettleMs ?? 300 });
        await page.screenshot({ path: screenshotAbs, fullPage: false });
        result.screenshot = screenshotRel;
      } catch {
        result.screenshot = null;
      }
      results.push(result);
    }
  }

  return results;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeHtmlReport(report, outPath) {
  const rows = report.matrix
    .map((entry) => `<tr><td>${htmlEscape(entry.route?.label || "Home")}</td><td>${htmlEscape(entry.browser)}</td><td>${htmlEscape(entry.device)}</td><td>${entry.viewport.width}x${entry.viewport.height}</td><td class="${entry.status}">${entry.status}</td><td>${entry.diagnostics ? htmlEscape(entry.diagnostics) : ""}</td><td>${htmlEscape(entry.notes.join("; "))}</td></tr>`)
    .join("");
  const scenarioRows = (report.scenarios || [])
    .map((entry) => `<tr><td>${htmlEscape(entry.route?.label || "Home")}</td><td>${htmlEscape(entry.name)}</td><td>${htmlEscape(entry.browser)}</td><td>${htmlEscape(entry.device)}</td><td class="${entry.status}">${entry.status}</td><td>${htmlEscape(entry.error || "")}</td></tr>`)
    .join("");
  const findings = report.findings
    .map((finding) => `<article class="finding ${finding.severity}">
      <div class="meta">${htmlEscape(finding.severity)} / ${htmlEscape(finding.category)} / ${htmlEscape(finding.confidence || "medium")} confidence / ${htmlEscape(finding.source || "rule")}</div>
      <h2>${htmlEscape(finding.id)} ${htmlEscape(finding.title)}</h2>
      <p><strong>Occurrences:</strong> ${finding.occurrenceCount || 1}</p>
      <p><strong>Section:</strong> ${htmlEscape(finding.section || finding.location?.section || "Page")}</p>
      <p><strong>State:</strong> ${htmlEscape(finding.state || "page-load")}</p>
      <p><strong>Expected:</strong> ${htmlEscape(finding.expected)}</p>
      <p><strong>Actual:</strong> ${htmlEscape(finding.actual)}</p>
      ${finding.measuredDelta ? `<pre>${htmlEscape(JSON.stringify({ measuredDelta: finding.measuredDelta }, null, 2))}</pre>` : ""}
      ${(finding.actualDetails || []).length > 1 ? `<pre>${htmlEscape(JSON.stringify({ actualDetails: finding.actualDetails }, null, 2))}</pre>` : ""}
      <p><strong>Suggested fix:</strong> ${htmlEscape(finding.suggestedFix)}</p>
      ${finding.location ? `<p><strong>Where:</strong> ${htmlEscape(finding.location.section || "Page")}${finding.location.textSnippet ? ` — ${htmlEscape(finding.location.textSnippet)}` : ""}</p>` : ""}
      ${finding.location?.selector ? `<p><strong>Selector:</strong> <code>${htmlEscape(finding.location.selector)}</code></p>` : ""}
      ${finding.ticket ? `<p><strong>Developer ticket:</strong> ${htmlEscape(finding.ticket)}</p>` : ""}
      <p><strong>Affected:</strong> ${htmlEscape(finding.affectedEnvironments.map((env) => `${env.route?.label || "Home"} / ${env.browser} ${env.device} ${env.viewport.width}x${env.viewport.height}`).join(", "))}</p>
      ${finding.evidence.annotatedScreenshot ? `<h3>Highlighted evidence</h3><img src="${htmlEscape(finding.evidence.annotatedScreenshot)}" alt="Highlighted screenshot evidence for ${htmlEscape(finding.title)}">` : ""}
      ${(finding.evidence.annotatedScreenshots || []).slice(1, 6).map((item) => `<p><a href="${htmlEscape(item)}">Additional crop: ${htmlEscape(item)}</a></p>`).join("")}
      ${(finding.examples || []).length ? `<pre>${htmlEscape(JSON.stringify(finding.examples, null, 2))}</pre>` : ""}
      ${!finding.evidence.annotatedScreenshot && finding.evidence.liveScreenshot ? `<img src="${htmlEscape(finding.evidence.liveScreenshot)}" alt="Live screenshot evidence">` : ""}
    </article>`)
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QC Audit Report</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f7f7f5;color:#171717}
    main{max-width:1120px;margin:0 auto;padding:40px 20px}
    h1{font-size:32px;margin:0 0 8px} h2{font-size:18px;margin:8px 0} h3{font-size:14px;margin:14px 0 4px}
    .summary,.finding,table{background:#fff;border:1px solid #deded9;border-radius:8px}
    .summary{padding:20px;margin:24px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px}
    .metric{font-size:28px;font-weight:650}.label,.meta{color:#6b6b65;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
    table{width:100%;border-collapse:collapse;overflow:hidden;margin:20px 0}td,th{padding:10px;border-bottom:1px solid #eee;text-align:left;font-size:14px}
    .passed{color:#137333}.failed{color:#b3261e}.skipped{color:#8a5a00}
    .finding{padding:18px;margin:16px 0}.critical{border-color:#b3261e}.high{border-color:#c74600}.medium{border-color:#b7791f}.low{border-color:#5f6368}
    img{max-width:100%;border:1px solid #e5e5e0;border-radius:6px;margin-top:10px}
    pre{background:#f7f7f5;border:1px solid #e5e5e0;border-radius:6px;padding:12px;overflow:auto;font-size:12px;line-height:1.5} code{background:#f7f7f5;border:1px solid #e5e5e0;border-radius:4px;padding:2px 4px}
  </style>
</head>
<body><main>
  <h1>QC Audit Report</h1>
  <p>${htmlEscape(report.url)} / ${htmlEscape(report.createdAt)}</p>
  <section class="summary">
    <div><div class="label">Score</div><div class="metric">${report.score}</div></div>
    <div><div class="label">Critical</div><div class="metric">${report.summary.critical}</div></div>
    <div><div class="label">High</div><div class="metric">${report.summary.high}</div></div>
    <div><div class="label">Medium</div><div class="metric">${report.summary.medium}</div></div>
    <div><div class="label">Low</div><div class="metric">${report.summary.low}</div></div>
    <div><div class="label">Gate</div><div class="metric ${report.gates?.status === "failed" ? "failed" : "passed"}">${htmlEscape(report.gates?.status || "n/a")}</div></div>
  </section>
  ${report.gates?.failures?.length ? `<h2>Gate Failures</h2><pre>${htmlEscape(JSON.stringify(report.gates.failures, null, 2))}</pre>` : ""}
  ${report.routeDiscovery?.enabled ? `<h2>Route Discovery</h2><p>Discovered ${report.routeDiscovery.discovered.length} route(s).${report.routeDiscovery.error ? ` Error: ${htmlEscape(report.routeDiscovery.error)}` : ""}</p>` : ""}
  <h2>Browser / Device Matrix</h2>
  <table><thead><tr><th>Route</th><th>Browser</th><th>Device</th><th>Viewport</th><th>Status</th><th>Diagnostics</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>
  ${scenarioRows ? `<h2>Scenarios</h2><table><thead><tr><th>Route</th><th>Name</th><th>Browser</th><th>Device</th><th>Status</th><th>Error</th></tr></thead><tbody>${scenarioRows}</tbody></table>` : ""}
  <h2>Findings</h2>
  ${findings || "<p>No findings were detected by the automated checks.</p>"}
</main></body></html>`;
  fs.writeFileSync(outPath, html);
}

function writeMarkdownSummary(report, outPath) {
  const lines = [];
  const topFindings = [...report.findings]
    .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
    .slice(0, 12);
  const failedScenarios = (report.scenarios || []).filter((scenario) => scenario.status === "failed");
  const skipped = report.matrix.filter((entry) => entry.status === "skipped");

  lines.push(`# QC Audit Summary`);
  lines.push("");
  lines.push(`Run ID: \`${report.runId}\``);
  lines.push(`URL: \`${report.url}\``);
  lines.push(`Score: \`${report.score}\``);
  lines.push(`Gate: \`${report.gates?.status || "n/a"}\``);
  lines.push(`Review mode: \`${report.reviewMode || "evidence-first"}\``);
  lines.push("");
  lines.push(`## Severity Breakdown`);
  lines.push("");
  lines.push(`- Critical: ${report.summary.critical}`);
  lines.push(`- High: ${report.summary.high}`);
  lines.push(`- Medium: ${report.summary.medium}`);
  lines.push(`- Low: ${report.summary.low}`);
  lines.push(`- Skipped browser/device rows: ${report.summary.skipped}`);
  lines.push("");
  lines.push(`## Browser Matrix`);
  lines.push("");
  if (report.routeDiscovery?.enabled) {
    lines.push(`Route discovery: ${report.routeDiscovery.discovered.length} discovered route(s)${report.routeDiscovery.error ? `; error: ${report.routeDiscovery.error}` : ""}`);
    lines.push("");
  }
  for (const entry of report.matrix) {
    lines.push(`- ${entry.route?.label || "Home"} / ${entry.browser} / ${entry.device} / ${entry.viewport.width}x${entry.viewport.height}: ${entry.status}${entry.diagnostics ? `; diagnostics: ${entry.diagnostics}` : ""}${entry.notes.length ? ` (${entry.notes.join("; ")})` : ""}`);
  }
  if (failedScenarios.length > 0) {
    lines.push("");
    lines.push(`## Failed Scenarios`);
    lines.push("");
    for (const scenario of failedScenarios) {
      lines.push(`- ${scenario.name} on ${scenario.route?.label || "Home"} / ${scenario.browser} ${scenario.device}: ${scenario.error || "failed"}`);
    }
  }
  if (report.gates?.failures?.length) {
    lines.push("");
    lines.push(`## Gate Failures`);
    lines.push("");
    for (const failure of report.gates.failures) {
      lines.push(`- ${failure}`);
    }
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(`## Skipped Coverage`);
    lines.push("");
    for (const entry of skipped) {
      lines.push(`- ${entry.route?.label || "Home"} / ${entry.browser} / ${entry.device}: ${entry.notes.join("; ")}`);
    }
  }
  lines.push("");
  lines.push(`## Top Findings`);
  lines.push("");
  for (const finding of topFindings) {
    const affected = finding.affectedEnvironments.map((env) => `${env.route?.label || "Home"} / ${env.browser} ${env.device} ${env.viewport.width}x${env.viewport.height}`).join(", ");
    lines.push(`### ${finding.id} ${finding.title}`);
    lines.push("");
    lines.push(`- Severity: ${finding.severity}`);
    lines.push(`- Confidence: ${finding.confidence || "medium"}`);
    lines.push(`- Category: ${finding.category}`);
    lines.push(`- Source: ${finding.source || "rule"}`);
    lines.push(`- State: ${finding.state || "page-load"}`);
    lines.push(`- Section: ${finding.section || finding.location?.section || "Page"}`);
    lines.push(`- Affected: ${affected}`);
    lines.push(`- Actual: ${finding.actual}`);
    lines.push(`- Fix: ${finding.suggestedFix}`);
    if (finding.ticket) lines.push(`- Developer ticket: ${finding.ticket}`);
    if ((finding.examples || []).length > 0) {
      lines.push(`- Example: \`${JSON.stringify(finding.examples[0]).slice(0, 240)}\``);
    }
    lines.push("");
  }
  lines.push(`## Artifacts`);
  lines.push("");
  lines.push(`- HTML report: report.html`);
  lines.push(`- JSON report: report.json`);
  lines.push(`- Screenshots: screenshots/`);
  lines.push(`- Diagnostics: diagnostics/`);
  if ((report.scenarios || []).length > 0) lines.push(`- Scenario screenshots: scenarios/`);
  lines.push(`- Diffs: diffs/`);
  lines.push(`- State captures: states/`);
  lines.push(`- Developer tickets: tickets/`);

  fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
}

function evaluateGates(report, config) {
  const gates = config.gates || config.thresholds || {};
  const failures = [];
  const failedMatrixRows = report.matrix.filter((entry) => entry.status === "failed").length;
  const failedScenarios = (report.scenarios || []).filter((scenario) => scenario.status === "failed").length;

  if (typeof gates.minScore === "number" && report.score < gates.minScore) {
    failures.push(`Score ${report.score} is below minScore ${gates.minScore}.`);
  }
  for (const severity of ["critical", "high", "medium", "low"]) {
    const key = `max${severity[0].toUpperCase()}${severity.slice(1)}`;
    if (typeof gates[key] === "number" && report.summary[severity] > gates[key]) {
      failures.push(`${severity} findings ${report.summary[severity]} exceeds ${key} ${gates[key]}.`);
    }
  }
  if (typeof gates.maxFailedEnvironments === "number" && failedMatrixRows > gates.maxFailedEnvironments) {
    failures.push(`Failed environments ${failedMatrixRows} exceeds maxFailedEnvironments ${gates.maxFailedEnvironments}.`);
  }
  if (typeof gates.maxSkippedEnvironments === "number" && report.summary.skipped > gates.maxSkippedEnvironments) {
    failures.push(`Skipped environments ${report.summary.skipped} exceeds maxSkippedEnvironments ${gates.maxSkippedEnvironments}.`);
  }
  if (typeof gates.maxFailedScenarios === "number" && failedScenarios > gates.maxFailedScenarios) {
    failures.push(`Failed scenarios ${failedScenarios} exceeds maxFailedScenarios ${gates.maxFailedScenarios}.`);
  }

  return {
    status: failures.length > 0 ? "failed" : "passed",
    failures,
    thresholds: gates,
  };
}

async function auditEnvironment(playwright, config, runId, browserName, viewport, route, outDir, matrix, findings, scenarioResults) {
  const screenshotRel = path.join("screenshots", `${slug(browserName)}-${slug(viewport.key)}-${slug(route.id)}.png`);
  const screenshotAbs = path.join(outDir, screenshotRel);
  ensureDir(path.dirname(screenshotAbs));

  let browserTypeName = browserName;
  const launchOptions = { headless: true };
  if (["chrome", "edge", "brave", "opera", "vivaldi"].includes(browserName)) {
    const executablePath = browserExecutable(browserName);
    if (!executablePath) {
      matrix.push({
        id: `${browserName}-${viewport.key}`,
        browser: browserName,
        device: viewport.label,
        route: { id: route.id, label: route.label, url: route.url },
        viewport: { width: viewport.width, height: viewport.height },
        status: "skipped",
        screenshot: null,
        durationMs: 0,
        notes: [`${browserName} executable was not found on this machine.`],
      });
      return;
    }
    browserTypeName = "chromium";
    launchOptions.executablePath = executablePath;
  }

  const browserType = playwright[browserTypeName];
  if (!browserType) {
    throw new Error(`Unsupported browser: ${browserName}`);
  }

  const startedAt = Date.now();
  const consoleErrors = [];
  const networkFailures = [];
  const consoleMessages = [];
  const responses = [];
  const requests = [];
  let browser;
  let userAgent = "";
  let diagnosticsRel = null;

  try {
    browser = await browserType.launch(launchOptions);
    const context = await browser.newContext(contextOptions(config, viewport));
    const page = await context.newPage();
    await applySessionSetup(context, page, config, route.url);
    page.on("console", (message) => {
      consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
      if (["error", "warning"].includes(message.type())) {
        consoleErrors.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("request", (request) => {
      requests.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
    });
    page.on("response", (response) => {
      responses.push({ status: response.status(), url: response.url(), request: { method: response.request().method(), resourceType: response.request().resourceType() } });
    });
    page.on("requestfailed", (request) => {
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`.trim());
    });

    const response = await page.goto(route.url, { waitUntil: "networkidle", timeout: config.timeoutMs || 45000 });
    userAgent = await page.evaluate(() => navigator.userAgent);
    await waitForVisualSettle(page, config);
    await page.screenshot({ path: screenshotAbs, fullPage: true });
    const stateArtifacts = await captureStateSnapshots(page, config, browserName, viewport, route, outDir);
    const sectionArtifacts = await captureSectionSnapshots(page, config, browserName, viewport, route, outDir);

    const env = environment(browserName, viewport, userAgent, route);
    let diffRel = null;
    const baseEvidence = () => ({
      ...evidenceFor(viewport, screenshotRel, diffRel),
      stateScreenshots: stateArtifacts.map((artifact) => artifact.screenshot),
      sectionScreenshots: sectionArtifacts.map((artifact) => artifact.screenshot),
    });
    const steps = ["Open URL", `Set viewport to ${viewport.width}x${viewport.height}`, "Wait for network idle", "Capture screenshot"];
    const runtime = await collectRuntimeMetrics(page);

    if (config.mode === "agentic") {
      if (!config.geminiApiKey) {
        addFinding(findings, {
          title: "Gemini API Key missing",
          fingerprint: `gemini:missing-api-key:${route.id}:${viewport.key}`,
          severity: "high",
          category: "agentic qc",
          source: "gemini-audit",
          affectedEnvironments: [env],
          evidence: baseEvidence(),
          expected: "A Gemini API Key must be supplied in settings to run agentic visual audits.",
          actual: "No Gemini API Key was found in the configuration settings.",
          suggestedFix: "Provide a valid Gemini API Key (beginning with AIzaSy) in the setup advanced settings.",
          reproduction: reproduction(config, runId, viewport, userAgent, browserName, ["Inspect audit configuration"], route),
        });
      } else {
        try {
          const screenshotBase64 = fs.readFileSync(screenshotAbs, { encoding: "base64" });
          const apiModel = config.geminiModel || "gemini-1.5-flash";
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${config.geminiApiKey}`;
          
          const systemPrompt = `You are an expert Quality Assurance Engineer. Analyze the screenshot of the webpage for the viewport "${viewport.label}" (${viewport.width}x${viewport.height}px) on browser "${browserName}".
Your goal: ${config.agentGoal || "Analyze the screenshot of the webpage and identify visual bugs, styling errors, text clipping, contrast issues, or layout alignment flaws."}

Find visual, layout, structural, and aesthetic issues. Be specific and identify exact locations, sections, elements, or text clippings where they occur.
For each visual/layout finding, please identify the bounding box coordinates of the affected area on the screenshot. The coordinates (ymin, xmin, ymax, xmax) must be integers in the range [0, 1000] representing the percentage from the top/left/bottom/right edges (e.g., ymin=100 means 10% from the top).`;

          const responseSchema = {
            type: "OBJECT",
            properties: {
              findings: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    title: { type: "STRING" },
                    severity: { 
                      type: "STRING", 
                      enum: ["critical", "high", "medium", "low"] 
                    },
                    category: { type: "STRING" },
                    expected: { type: "STRING" },
                    actual: { type: "STRING" },
                    suggestedFix: { type: "STRING" },
                    location: {
                      type: "OBJECT",
                      properties: {
                        section: { type: "STRING" },
                        selector: { type: "STRING" },
                        textSnippet: { type: "STRING" }
                      },
                      required: ["section"]
                    },
                    boundingBox: {
                      type: "OBJECT",
                      properties: {
                        ymin: { type: "INTEGER", description: "Top coordinate of the bounding box, normalized from 0 to 1000" },
                        xmin: { type: "INTEGER", description: "Left coordinate of the bounding box, normalized from 0 to 1000" },
                        ymax: { type: "INTEGER", description: "Bottom coordinate of the bounding box, normalized from 0 to 1000" },
                        xmax: { type: "INTEGER", description: "Right coordinate of the bounding box, normalized from 0 to 1000" }
                      },
                      required: ["ymin", "xmin", "ymax", "xmax"]
                    }
                  },
                  required: ["title", "severity", "category", "expected", "actual", "suggestedFix"]
                }
              }
            },
            required: ["findings"]
          };

          const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: systemPrompt },
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data: screenshotBase64
                      }
                    }
                  ]
                }
              ],
              generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema
              }
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Gemini API returned status ${response.status}: ${errText}`);
          }

          const data = await response.json();
          const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!jsonText) {
            throw new Error("Empty response from Gemini API");
          }

          const parsed = JSON.parse(jsonText);
          const geminiFindings = parsed.findings || [];

          let imageWidth = viewport.width || 1440;
          let imageHeight = viewport.height || 1000;
          try {
            const size = readPngSize(screenshotAbs);
            imageWidth = size.width;
            imageHeight = size.height;
          } catch (e) {}

          for (const item of geminiFindings) {
            const examples = [];
            if (item.boundingBox) {
              const ymin = Math.max(0, Math.min(1000, item.boundingBox.ymin));
              const xmin = Math.max(0, Math.min(1000, item.boundingBox.xmin));
              const ymax = Math.max(ymin, Math.min(1000, item.boundingBox.ymax));
              const xmax = Math.max(xmin, Math.min(1000, item.boundingBox.xmax));

              const x = Math.round((xmin / 1000) * imageWidth);
              const y = Math.round((ymin / 1000) * imageHeight);
              const width = Math.max(1, Math.round(((xmax - xmin) / 1000) * imageWidth));
              const height = Math.max(1, Math.round(((ymax - ymin) / 1000) * imageHeight));

              examples.push({
                rect: { x, y, width, height },
                label: item.title,
                location: {
                  sectionSelector: item.location?.selector || null,
                  selector: item.location?.selector || null,
                  textSnippet: item.location?.textSnippet || null
                }
              });
            }

            addFinding(findings, {
              title: item.title,
              fingerprint: `gemini:finding:${route.id}:${viewport.key}:${slug(item.title)}`,
              severity: item.severity || "medium",
              category: item.category || "visual",
              source: "gemini-audit",
              state: "settled",
              confidence: "high",
              affectedEnvironments: [env],
              evidence: baseEvidence(),
              location: {
                section: item.location?.section || "Page",
                selector: item.location?.selector || "",
                textSnippet: item.location?.textSnippet || ""
              },
              expected: item.expected || "The webpage elements should be visually correct and follow layout guidelines.",
              actual: item.actual || "Visual or layout discrepancy identified by visual QA audit.",
              suggestedFix: item.suggestedFix || "Review layout code, styling definitions, and content alignment.",
              examples: examples,
              reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
            });
          }
        } catch (err) {
          addFinding(findings, {
            title: "Gemini visual QA audit failed",
            fingerprint: `gemini:audit-error:${route.id}:${viewport.key}`,
            severity: "high",
            category: "agentic qc",
            source: "gemini-audit",
            affectedEnvironments: [env],
            evidence: baseEvidence(),
            expected: "Gemini API should analyze screenshot and return layout findings.",
            actual: `API execution failed: ${err.message}`,
            suggestedFix: "Check your internet connection, Gemini API key, rate limits, quota, and selected model configuration.",
            reproduction: reproduction(config, runId, viewport, userAgent, browserName, ["Check Gemini API configurations"], route),
          });
        }
      }
    } else {
      if (viewport.figmaReferenceImage) {
        const figmaImagePath = path.resolve(viewport.figmaReferenceImage);
        if (fs.existsSync(figmaImagePath)) {
          diffRel = path.join("diffs", `${slug(browserName)}-${slug(viewport.key)}-${slug(route.id)}.json`);
          const diffAbs = path.join(outDir, diffRel);
          const diff = comparePngs(figmaImagePath, screenshotAbs, config.diffThreshold || 40);
          fs.writeFileSync(diffAbs, JSON.stringify(diff, null, 2));
          const mismatchRatio = diff.pixelDiff?.mismatchRatio || 0;
          if (!diff.sizeMatches || mismatchRatio > (config.allowedMismatchRatio || 0.08)) {
            const visualClass = classifyVisualDiff(diff);
            addFinding(findings, {
              title: `Figma parity ${visualClass.type}`,
              fingerprint: `figma:visual-diff:${route.id}:${viewport.key}`,
              severity: mismatchRatio > 0.25 || Math.abs(diff.dimensionDelta.width) > 80 ? "high" : "medium",
              category: "design parity",
              source: "figma-parity",
              state: "settled",
              confidence: diff.pixelDiffAvailable ? "medium" : "low",
              affectedEnvironments: [env],
              evidence: baseEvidence(),
              designReference: {
                frameUrl: viewport.figmaReference || null,
                image: viewport.figmaReferenceImage || null,
                breakpoint: viewport.key,
              },
              measuredDelta: {
                type: visualClass.type,
                mismatchRatio,
                dimensionDelta: diff.dimensionDelta,
                mismatchBounds: diff.pixelDiff?.mismatchBounds || null,
              },
              expected: "The live screenshot should match the exported Figma reference within the configured tolerance.",
              actual: diff.pixelDiffAvailable
                ? `${visualClass.summary} Mismatch ratio is ${(mismatchRatio * 100).toFixed(2)}%; dimension delta is ${diff.dimensionDelta.width}x${diff.dimensionDelta.height}px.`
                : `Dimension delta is ${diff.dimensionDelta.width}x${diff.dimensionDelta.height}px; pixel diff unavailable because pngjs was not found.`,
              suggestedFix: "Compare the Figma reference and live screenshot, then adjust layout, spacing, typography, imagery, and responsive rules for this breakpoint.",
              examples: [diff.pixelDiff?.mismatchBounds || diff.dimensionDelta],
              reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
            });
          }
        } else {
          addFinding(findings, {
            title: "Figma reference image path is missing",
            fingerprint: `figma:missing-reference-image:${route.id}:${viewport.key}`,
            severity: "low",
            category: "design parity",
            affectedEnvironments: [env],
            evidence: baseEvidence(),
            expected: "Configured Figma reference image paths should exist before visual parity comparison runs.",
            actual: `Reference image was not found at ${figmaImagePath}.`,
            suggestedFix: "Export the Figma frame screenshot and update figmaReferenceImage for this breakpoint.",
            examples: [{ figmaReferenceImage: figmaImagePath }],
            reproduction: reproduction(config, runId, viewport, userAgent, browserName, ["Inspect audit configuration"], route),
          });
        }
      }

      if (viewport.figmaReference && !viewport.figmaReferenceImage) {
        addFinding(findings, {
          title: "Figma frame URL provided without reference image",
          fingerprint: `figma:reference-url-without-image:${route.id}:${viewport.key}`,
          severity: "low",
          category: "design parity",
          affectedEnvironments: [env],
          evidence: baseEvidence(),
          expected: "A Figma frame URL should be paired with an exported frame PNG when pixel-level visual parity is required.",
          actual: `A Figma frame URL was provided for ${viewport.label}, but no figmaReferenceImage path was available for screenshot diffing.`,
          suggestedFix: "Export/capture the Figma frame to a PNG with Figma MCP or Figma export, then add that local PNG path to the matching breakpoint reference image field.",
          examples: [{ figmaReference: viewport.figmaReference, breakpoint: viewport.key }],
          reproduction: reproduction(config, runId, viewport, userAgent, browserName, ["Inspect audit configuration"], route),
        });
      }
    }

    if (!response || response.status() >= 400) {
      addFinding(findings, {
        title: "Page returns an unsuccessful HTTP status",
        fingerprint: "network:http-status",
        severity: "critical",
        category: "console/network",
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        expected: "The audited page should load successfully.",
        actual: `Navigation returned ${response ? response.status() : "no response"}.`,
        suggestedFix: "Check deployment, routing, redirects, authentication, and server health for this URL.",
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    for (const issue of await collectLayoutIssues(page)) {
      addFinding(findings, {
        ...issue,
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    for (const issue of await collectAccessibility(page)) {
      addFinding(findings, {
        ...issue,
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    for (const issue of await collectContrastIssues(page)) {
      addFinding(findings, {
        ...issue,
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    for (const issue of await collectPerformanceIssues(page)) {
      addFinding(findings, {
        ...issue,
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    for (const issue of await collectInteractionIssues(page, config.interactions)) {
      addFinding(findings, {
        ...issue,
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    const scenarios = scenariosFor(config, viewport, route);
    if (scenarios.length > 0) {
      await page.goto(route.url, { waitUntil: "networkidle", timeout: config.timeoutMs || 45000 });
      await waitForVisualSettle(page, config);
      const results = await runScenarios(page, scenarios, browserName, viewport, route, outDir);
      scenarioResults.push(...results);
      for (const result of results.filter((item) => item.status === "failed")) {
        addFinding(findings, {
          title: `Scenario failed: ${result.name}`,
          fingerprint: `scenario:${route.id}:${result.id}`,
          severity: "high",
          category: "interaction",
          affectedEnvironments: [env],
          evidence: {
            ...baseEvidence(),
            scenarioScreenshot: result.screenshot,
          },
          expected: `Scenario "${result.name}" should complete successfully.`,
          actual: result.error || "Scenario failed.",
          suggestedFix: "Reproduce the listed scenario steps in this browser/viewport and fix the broken interaction, selector target, route change, or expected state.",
          examples: result.steps,
          reproduction: reproduction(config, runId, viewport, userAgent, browserName, (scenarios.find((scenario) => slug(scenario.id || scenario.name) === result.id)?.steps || []).map((step) => `${step.action || step.type}${step.selector ? ` ${step.selector}` : ""}`), route),
        });
      }
    }

    if (consoleErrors.length > 0) {
      addFinding(findings, {
        title: "Console errors or warnings detected",
        fingerprint: "network:console-errors",
        severity: consoleErrors.some((line) => line.startsWith("error:")) ? "high" : "low",
        category: "console/network",
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        expected: "The page should load without console errors in the tested environment.",
        actual: consoleErrors.slice(0, 5).join(" | "),
        suggestedFix: "Open DevTools in the affected browser, reproduce the page load, and fix the logged runtime errors.",
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    if (networkFailures.length > 0) {
      addFinding(findings, {
        title: "Network requests failed",
        fingerprint: "network:request-failures",
        severity: "high",
        category: "console/network",
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        expected: "Required assets and API requests should complete successfully.",
        actual: networkFailures.slice(0, 5).join(" | "),
        suggestedFix: "Inspect failed request URLs, CORS policy, asset paths, and API availability.",
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, steps, route),
      });
    }

    if (config.mode !== "agentic" && !viewport.figmaReference) {
      addFinding(findings, {
        title: "Figma reference missing for breakpoint",
        fingerprint: `figma:missing-reference:${route.id}:${viewport.key}`,
        severity: "low",
        category: "design parity",
        affectedEnvironments: [env],
        evidence: baseEvidence(),
        expected: "A Figma reference should be available for precise parity checks.",
        actual: `No Figma reference was provided for ${viewport.label}.`,
        suggestedFix: "Provide the exact Figma frame/node URL or exported PNG for this breakpoint.",
        reproduction: reproduction(config, runId, viewport, userAgent, browserName, ["Inspect audit configuration"], route),
      });
    }

    diagnosticsRel = writeDiagnostics(outDir, browserName, viewport, route, {
      route: { id: route.id, label: route.label, url: route.url },
      browser: browserName,
      device: viewport.label,
      viewport: { width: viewport.width, height: viewport.height },
      userAgent,
      status: response ? response.status() : null,
      runtime,
      console: consoleMessages.slice(0, config.maxDiagnosticsEntries || 200),
      failedRequests: networkFailures.slice(0, config.maxDiagnosticsEntries || 200),
      responses: responses.slice(0, config.maxDiagnosticsEntries || 200),
      requests: requests.slice(0, config.maxDiagnosticsEntries || 200),
      screenshot: screenshotRel,
      stateArtifacts,
      sectionArtifacts,
      durationMs: Date.now() - startedAt,
    });

    matrix.push({
      id: `${browserName}-${viewport.key}`,
      browser: browserName,
      device: viewport.label,
      route: { id: route.id, label: route.label, url: route.url },
      viewport: { width: viewport.width, height: viewport.height },
      status: "passed",
      screenshot: screenshotRel,
      stateArtifacts,
      sectionArtifacts,
      diagnostics: diagnosticsRel,
      durationMs: Date.now() - startedAt,
      notes: [],
    });
  } catch (error) {
    if (!diagnosticsRel) {
      diagnosticsRel = writeDiagnostics(outDir, browserName, viewport, route, {
        route: { id: route.id, label: route.label, url: route.url },
        browser: browserName,
        device: viewport.label,
        viewport: { width: viewport.width, height: viewport.height },
        userAgent,
        status: "failed",
        error: error.message,
        console: consoleMessages.slice(0, config.maxDiagnosticsEntries || 200),
        failedRequests: networkFailures.slice(0, config.maxDiagnosticsEntries || 200),
        responses: responses.slice(0, config.maxDiagnosticsEntries || 200),
        requests: requests.slice(0, config.maxDiagnosticsEntries || 200),
        screenshot: fs.existsSync(screenshotAbs) ? screenshotRel : null,
        durationMs: Date.now() - startedAt,
      });
    }
    matrix.push({
      id: `${browserName}-${viewport.key}`,
      browser: browserName,
      device: viewport.label,
      route: { id: route.id, label: route.label, url: route.url },
      viewport: { width: viewport.width, height: viewport.height },
      status: "failed",
      screenshot: fs.existsSync(screenshotAbs) ? screenshotRel : null,
      diagnostics: diagnosticsRel,
      durationMs: Date.now() - startedAt,
      notes: [error.message],
    });
    addFinding(findings, {
      title: "Audit failed in environment",
      fingerprint: "network:audit-environment-failure",
      severity: "critical",
      category: "console/network",
      affectedEnvironments: [
        {
          browser: browserName,
          device: viewport.label,
          route: { id: route.id, label: route.label, url: route.url },
          viewport: { width: viewport.width, height: viewport.height },
          userAgent,
        },
      ],
      evidence: { liveScreenshot: fs.existsSync(screenshotAbs) ? screenshotRel : null, figmaReference: viewport.figmaReference || null, diff: null },
      expected: "The audit should be able to load and inspect the page.",
      actual: error.message,
      suggestedFix: "Check URL reachability, SSL issues, authentication, browser availability, and page load stability.",
      reproduction: reproduction(config, runId, viewport, userAgent, browserName, ["Open URL", `Set viewport to ${viewport.width}x${viewport.height}`], route),
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function summarize(findings, matrix) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, skipped: matrix.filter((entry) => entry.status === "skipped").length };
  for (const finding of findings) {
    if (summary[finding.severity] !== undefined) {
      summary[finding.severity] += 1;
    }
  }
  const penalty = findings.reduce((total, finding) => total + severityWeight(finding.severity), 0);
  return { summary, score: Math.max(0, Math.min(100, 100 - penalty)) };
}

async function main() {
  const args = parseArgs(process.argv);
  const { config, configPath } = loadConfig(args);
  const playwright = tryRequirePlaywright();
  const runId = config.runId || `qc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = path.resolve(config.outDir || path.join(process.cwd(), "qc-audit-runs", runId));
  ensureDir(outDir);
  for (const dir of ["screenshots", "diffs", "figma", "states", "sections", "tickets", "annotations", "diagnostics", "scenarios"]) {
    resetArtifactDir(outDir, dir);
  }

  const matrix = [];
  const findings = [];
  const scenarioResults = [];
  const browsers = requestedBrowsers(config);
  const viewportList = viewports(config);
  const baseRoutes = routesFor(config);
  const discoveryResult = await discoverRoutes(playwright, config, baseRoutes, viewportList[0] || DEFAULT_VIEWPORTS.desktop);
  const routeList = discoveryResult.routes;

  for (const browserName of browsers) {
    for (const viewport of viewportList) {
      for (const route of routeList) {
        await auditEnvironment(playwright, config, runId, browserName, routeViewport(viewport, route), route, outDir, matrix, findings, scenarioResults);
      }
    }
  }

  let groupedFindings = dedupeFindings(findings);
  writeAnnotatedEvidence(outDir, groupedFindings);
  groupedFindings = enrichFindingsForReview(groupedFindings);
  writeDeveloperTickets(outDir, groupedFindings);
  const { summary, score } = summarize(groupedFindings, matrix);
  const report = {
    runId,
    url: config.url,
    createdAt: new Date().toISOString(),
    sourceConfig: configPath,
    score,
    summary,
    gates: null,
    routes: routeList,
    routeDiscovery: {
      enabled: Boolean(config.discoverRoutes || config.routeDiscovery),
      discovered: discoveryResult.discovered,
      error: discoveryResult.error,
    },
    matrix,
    scenarios: scenarioResults,
    reviewMode: config.reviewMode || "evidence-first",
    stateCapture: stateCaptureOptions(config),
    figmaReferences: config.figmaReferences || {},
    figmaFrames: config.figmaFrames || {},
    figmaReferenceImages: config.figmaReferenceImages || {},
    findings: groupedFindings,
    reviewBoard: {
      groupBy: ["route", "section", "severity"],
      filters: ["browser", "device", "severity", "confidence", "category", "section", "source", "state"],
    },
    artifacts: {
      html: "report.html",
      json: "report.json",
      summary: "developer-summary.md",
      screenshots: "screenshots",
      diagnostics: "diagnostics",
      scenarios: "scenarios",
      diffs: "diffs",
      figma: "figma",
      annotations: "annotations",
      states: "states",
      sections: "sections",
      tickets: "tickets",
    },
  };
  report.gates = evaluateGates(report, config);

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeHtmlReport(report, path.join(outDir, "report.html"));
  writeMarkdownSummary(report, path.join(outDir, "developer-summary.md"));

  console.log(JSON.stringify({ runId, outDir, reportJson: path.join(outDir, "report.json"), reportHtml: path.join(outDir, "report.html"), developerSummary: path.join(outDir, "developer-summary.md"), score, findings: groupedFindings.length, rawFindings: findings.length, scenarios: scenarioResults.length }, null, 2));
  if ((config.ci || config.failOnGateFailure) && report.gates.status === "failed") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
