let activeJobId = null;
let pollTimer = null;
let activeFindingIndex = 0;
let activeCaptureIndex = 0;
let activeLiveEnvironmentIndex = 0;
let activePreviewMode = "issue";
let captureTimer = null;
let findingFilters = {};

const form = document.querySelector("#auditForm");
const formNote = document.querySelector("#formNote");
const jobsList = document.querySelector("#jobsList");
const detailDrawer = document.querySelector("#detail-drawer");
const detailDrawerContent = document.querySelector("#detailDrawerContent");
const detailDrawerClose = document.querySelector("#detail-drawer-close");
const refreshJobs = document.querySelector("#refreshJobs");
const health = document.querySelector("#health");
const previewCanvas = document.querySelector("#previewCanvas");
const previewTitle = document.querySelector("#previewTitle");
const summaryPills = document.querySelector("#summaryPills");
const previewModes = document.querySelector("#previewModes");
const matrixPills = document.querySelector("#matrixPills");
const artifactLinks = document.querySelector("#artifactLinks");
const reviewFilters = document.querySelector("#reviewFilters");
const findingRail = document.querySelector("#findingRail");

function checkedValues(group) {
  return Array.from(document.querySelectorAll(`[data-group="${group}"] input:checked`)).map((input) => input.value);
}

function value(name) {
  return form.elements[name]?.value?.trim() || "";
}

function checked(name) {
  return Boolean(form.elements[name]?.checked);
}

function viewport(key) {
  return {
    enabled: checked(`${key}-enabled`),
    width: Number(value(`${key}-width`)),
    height: Number(value(`${key}-height`)),
    figmaReference: value(`figma-${key}`),
    figmaReferenceImage: value(`${key}-image`),
  };
}

function payloadFromForm() {
  return {
    url: value("url"),
    title: value("title"),
    browsers: checkedValues("browsers"),
    interactions: checkedValues("interactions"),
    routes: value("routes"),
    discoverRoutes: checked("discoverRoutes"),
    sitemap: checked("sitemap"),
    maxRoutes: Number(value("maxRoutes") || 6),
    viewports: {
      desktop: viewport("desktop"),
      tablet: viewport("tablet"),
      mobile: viewport("mobile"),
    },
  };
}

function parityWarnings(payload) {
  return Object.entries(payload.viewports || {})
    .filter(([, viewport]) => viewport?.figmaReference && !viewport?.figmaReferenceImage)
    .map(([key]) => `${key}: Figma URL saved, but visual diff needs a reference PNG path.`);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}

function statusBadge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

function artifactLink(job, label, file) {
  if (!job.id || !file) return "";
  return `<a href="/artifacts/${encodeURIComponent(job.id)}/${file}" target="_blank" rel="noreferrer">${label}</a>`;
}

function artifactUrl(job, file) {
  return `/artifacts/${encodeURIComponent(job.id)}/${file}`;
}

function stopCapturePlayback() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

function setPreviewMode(mode, job) {
  activePreviewMode = mode;
  activeCaptureIndex = 0;
  activeLiveEnvironmentIndex = 0;
  stopCapturePlayback();
  renderReportFromJob(job);
}

function updatePreviewModesSlider() {
  if (!previewModes) return;
  const activeBtn = previewModes.querySelector("[data-preview-mode].active");
  if (!activeBtn) {
    previewModes.style.setProperty("--active-width", "0px");
    return;
  }
  const containerRect = previewModes.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  const leftOffset = btnRect.left - containerRect.left;
  previewModes.style.setProperty("--active-left", `${leftOffset}px`);
  previewModes.style.setProperty("--active-width", `${btnRect.width}px`);
}

window.addEventListener("resize", updatePreviewModesSlider);

function renderPreviewModes(job) {
  if (!previewModes) return;
  if (!job?.report) {
    previewModes.innerHTML = "";
    return;
  }
  const modes = [
    ["issue", "Issue"],
    ["live", "Live page"],
    ["captures", "QC captures"],
  ];
  previewModes.innerHTML = modes.map(([mode, label]) => `
    <button type="button" class="${activePreviewMode === mode ? "active" : ""}" data-preview-mode="${mode}">
      ${label}
    </button>
  `).join("");
  previewModes.querySelectorAll("[data-preview-mode]").forEach((button) => {
    button.addEventListener("click", () => setPreviewMode(button.dataset.previewMode, job));
  });
  
  // Wait a layout tick for sizes to compute
  requestAnimationFrame(updatePreviewModesSlider);
}

function addCapture(captures, seen, type, label, file, meta = "") {
  if (!file || seen.has(file)) return;
  seen.add(file);
  captures.push({ type, label, file, meta });
}

function collectCaptures(job, finding) {
  const captures = [];
  const seen = new Set();
  const evidence = finding?.evidence || {};

  addCapture(captures, seen, "Issue", "Highlighted issue", evidence.annotatedScreenshot, finding?.section || finding?.location?.section || "");
  addCapture(captures, seen, "Issue", "Live issue view", evidence.liveScreenshot, finding?.state || "page-load");
  (evidence.annotatedScreenshots || []).forEach((file, index) => addCapture(captures, seen, "Issue", `Issue crop ${index + 1}`, file));
  (evidence.liveScreenshots || []).forEach((file, index) => addCapture(captures, seen, "Live", `Live screenshot ${index + 1}`, file));
  (evidence.stateScreenshots || []).forEach((file, index) => addCapture(captures, seen, "State", `State capture ${index + 1}`, file, finding?.state || ""));
  (evidence.sectionScreenshots || []).forEach((file, index) => addCapture(captures, seen, "Section", `Section capture ${index + 1}`, file, finding?.section || finding?.location?.section || ""));
  addCapture(captures, seen, "Figma", "Figma reference", evidence.figmaReferenceImage || evidence.figmaReference, finding?.designReference?.breakpoint || "");

  for (const row of job?.report?.matrix || []) {
    const label = `${row.browser || "browser"} ${row.device || "device"}`;
    addCapture(captures, seen, "Matrix", label, row.screenshot, row.route?.label || row.status || "");
    (row.stateArtifacts || []).forEach((artifact) => {
      const stateLabel = artifact.text || artifact.name || artifact.state || "State";
      const meta = [row.browser, row.device, artifact.state, artifact.scrollY ? `scrollY ${artifact.scrollY}` : ""].filter(Boolean).join(" · ");
      addCapture(captures, seen, "State", stateLabel, artifact.screenshot, meta);
    });
    (row.sectionArtifacts || []).forEach((artifact) => {
      const sectionLabel = artifact.label || `Section ${artifact.index + 1}`;
      const meta = [row.browser, row.device, row.route?.label].filter(Boolean).join(" · ");
      addCapture(captures, seen, "Section", sectionLabel, artifact.screenshot, meta);
    });
  }

  return captures;
}

function collectLiveEnvironments(job) {
  const seen = new Set();
  const environments = [];
  for (const row of job?.report?.matrix || []) {
    if (!row || row.status === "skipped") continue;
    const viewport = row.viewport || {};
    const key = [row.browser, row.device, viewport.width, viewport.height, row.route?.url].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    environments.push({
      browser: row.browser || "browser",
      device: row.device || "Device",
      viewport,
      url: row.route?.url || job.url,
      route: row.route?.label || "/",
      status: row.status || "unknown",
      screenshot: row.screenshot || "",
    });
  }
  if (!environments.length && job?.url) {
    environments.push({
      browser: "current",
      device: "Responsive",
      viewport: { width: 1440, height: 900 },
      url: job.url,
      route: "/",
      status: "preview",
      screenshot: "",
    });
  }
  return environments;
}

function browserLabel(browser) {
  const key = String(browser || "").toLowerCase();
  const labels = {
    chromium: "Chromium",
    chrome: "Google Chrome",
    firefox: "Firefox",
    webkit: "Safari / WebKit",
    brave: "Brave",
    opera: "Opera",
    edge: "Microsoft Edge",
    vivaldi: "Vivaldi",
  };
  return labels[key] || browser || "Browser";
}

function browserFrameClass(browser) {
  const key = String(browser || "").toLowerCase();
  if (key.includes("firefox")) return "browser-firefox";
  if (key.includes("webkit") || key.includes("safari")) return "browser-safari";
  if (key.includes("brave")) return "browser-brave";
  if (key.includes("opera")) return "browser-opera";
  if (key.includes("edge")) return "browser-edge";
  return "browser-chrome-like";
}

function deviceFrameClass(device) {
  const key = String(device || "").toLowerCase();
  if (key.includes("mobile") || key.includes("phone")) return "device-phone";
  if (key.includes("tablet") || key.includes("ipad")) return "device-tablet";
  return "device-desktop";
}

function deviceName(device) {
  const key = String(device || "").toLowerCase();
  if (key.includes("mobile") || key.includes("phone")) return "iPhone-style frame";
  if (key.includes("tablet") || key.includes("ipad")) return "Tablet frame";
  return "Desktop browser";
}

function renderCaptureReel(job, finding) {
  const captures = collectCaptures(job, finding);
  if (!captures.length) {
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>No capture reel yet</strong>
        <span>Run with scroll, hover, focus, forms, or sticky checks enabled to collect state screenshots.</span>
      </div>
    `;
    return;
  }

  activeCaptureIndex = Math.min(activeCaptureIndex, captures.length - 1);
  const active = captures[activeCaptureIndex];
  previewCanvas.className = "preview-canvas has-evidence capture-mode";
  previewCanvas.innerHTML = `
    <div class="capture-stage">
      <div class="browser-frame">
        <div class="browser-chrome">
          <span></span><span></span><span></span>
          <strong>${escapeHtml(active.type)}</strong>
          <em>${escapeHtml(active.label)}${active.meta ? ` · ${escapeHtml(active.meta)}` : ""}</em>
        </div>
        <div class="browser-viewport">
          <img src="${artifactUrl(job, active.file)}" alt="${escapeHtml(active.label)}">
        </div>
      </div>
      <div class="capture-controls">
        <button type="button" data-capture-prev>Previous</button>
        <button type="button" data-capture-play>${captureTimer ? "Pause" : "Play reel"}</button>
        <button type="button" data-capture-next>Next</button>
        <span>${activeCaptureIndex + 1} / ${captures.length}</span>
      </div>
      <div class="capture-strip" aria-label="QC capture thumbnails">
        ${captures.map((capture, index) => `
          <button type="button" class="${index === activeCaptureIndex ? "active" : ""}" data-capture="${index}">
            <span>${escapeHtml(capture.type)}</span>
            <strong>${escapeHtml(capture.label)}</strong>
          </button>
        `).join("")}
      </div>
    </div>
  `;

  previewCanvas.querySelector("[data-capture-prev]")?.addEventListener("click", () => {
    activeCaptureIndex = (activeCaptureIndex - 1 + captures.length) % captures.length;
    renderPreview(job, finding);
  });
  previewCanvas.querySelector("[data-capture-next]")?.addEventListener("click", () => {
    activeCaptureIndex = (activeCaptureIndex + 1) % captures.length;
    renderPreview(job, finding);
  });
  previewCanvas.querySelector("[data-capture-play]")?.addEventListener("click", () => {
    if (captureTimer) {
      stopCapturePlayback();
      renderPreview(job, finding);
      return;
    }
    captureTimer = setInterval(() => {
      activeCaptureIndex = (activeCaptureIndex + 1) % captures.length;
      renderPreview(job, finding);
    }, 1400);
    renderPreview(job, finding);
  });
  previewCanvas.querySelectorAll("[data-capture]").forEach((button) => {
    button.addEventListener("click", () => {
      activeCaptureIndex = Number(button.dataset.capture || 0);
      stopCapturePlayback();
      renderPreview(job, finding);
    });
  });
}

function renderLivePreview(job) {
  const environments = collectLiveEnvironments(job);
  if (!environments.length) {
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>No live environments yet</strong>
        <span>Run an audit to populate browser and breakpoint previews.</span>
      </div>
    `;
    return;
  }
  activeLiveEnvironmentIndex = Math.min(activeLiveEnvironmentIndex, environments.length - 1);
  const active = environments[activeLiveEnvironmentIndex];
  const width = Number(active.viewport?.width || 1440);
  const height = Number(active.viewport?.height || 900);
  const deviceClass = deviceFrameClass(active.device);
  const browserClass = browserFrameClass(active.browser);
  const label = browserLabel(active.browser);
  previewCanvas.className = "preview-canvas has-evidence live-mode";
  previewCanvas.innerHTML = `
    <div class="live-preview-layout">
      <div class="live-environment-bar" aria-label="Live preview environments">
        ${environments.map((environment, index) => `
          <button type="button" class="${index === activeLiveEnvironmentIndex ? "active" : ""}" data-live-env="${index}">
            <strong>${escapeHtml(environment.browser)} · ${escapeHtml(environment.device)}</strong>
            <span>${escapeHtml(environment.viewport?.width || "--")}x${escapeHtml(environment.viewport?.height || "--")}</span>
          </button>
        `).join("")}
      </div>
      <div class="live-browser-shell">
        <div class="browser-chrome">
          <span></span><span></span><span></span>
          <strong>${escapeHtml(label)} · ${escapeHtml(active.device)}</strong>
          <em>${escapeHtml(active.route)} · ${width}x${height} · ${escapeHtml(active.status)}</em>
          <a href="${escapeHtml(active.url || job.url || "#")}" target="_blank" rel="noreferrer">Open</a>
        </div>
        <div class="device-preview-surface">
          <div class="device-shell ${deviceClass} ${browserClass}" style="--device-width:${width}px;--device-height:${height}px">
            <div class="device-hardware-top" aria-hidden="true">
              <span class="device-camera"></span>
              <span class="device-speaker"></span>
            </div>
            <div class="browser-device-bar">
              <strong>${escapeHtml(label)}</strong>
              <span>${escapeHtml(deviceName(active.device))}</span>
            </div>
            <div class="device-screen">
              <iframe
                src="${escapeHtml(active.url || job.url || "about:blank")}"
                title="Live website preview for ${escapeHtml(label)} ${escapeHtml(active.device)}"
                loading="lazy"
                style="width:${width}px;height:${height}px"
              ></iframe>
            </div>
            <div class="device-home-indicator" aria-hidden="true"></div>
          </div>
        </div>
        <p>This is an interactive viewport preview. Browser-specific rendering differences are captured by the audit screenshots and QC capture reel.</p>
      </div>
    </div>
  `;

  previewCanvas.querySelectorAll("[data-live-env]").forEach((button) => {
    button.addEventListener("click", () => {
      activeLiveEnvironmentIndex = Number(button.dataset.liveEnv || 0);
      renderReportFromJob(job);
    });
  });
}

function renderJobs(jobs) {
  jobsList.innerHTML = jobs.length
    ? jobs.map((job) => `
      <article class="job">
        <div>
          <h3>${escapeHtml(job.title || job.id)}</h3>
          <p>${escapeHtml(job.url)} · ${escapeHtml(job.createdAt || "")}</p>
        </div>
        <div class="job-actions">
          ${statusBadge(job.status)}
          <button type="button" data-job="${escapeHtml(job.id)}">Open</button>
        </div>
      </article>
    `).join("")
    : `<div class="report-empty">No runs yet.</div>`;

  jobsList.querySelectorAll("button[data-job]").forEach((button) => {
    button.addEventListener("click", () => selectJob(button.dataset.job));
  });
}

function metricPills(report) {
  const summary = report?.summary || {};
  return `
    <span>Score ${report?.score ?? "--"}</span>
    <span>${summary.critical ?? 0} critical</span>
    <span>${summary.high ?? 0} high</span>
    <span>${summary.medium ?? 0} medium</span>
    <span>${summary.low ?? 0} low</span>
  `;
}

function renderPreview(job, finding) {
  if (!job?.report) {
    stopCapturePlayback();
    previewTitle.textContent = "No audit selected";
    summaryPills.innerHTML = `<span>Score --</span><span>0 findings</span>`;
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>Issue evidence will appear here</strong>
        <span>Run an audit, then select a finding to preview the cropped highlighted screenshot.</span>
      </div>
    `;
    matrixPills.innerHTML = "";
    artifactLinks.innerHTML = "";
    if (previewModes) previewModes.innerHTML = "";
    if (reviewFilters) reviewFilters.innerHTML = "";
    findingRail.innerHTML = "";
    return;
  }

  renderPreviewModes(job);
  summaryPills.innerHTML = metricPills(job.report);
  const matrix = job.report.matrix || [];
  matrixPills.innerHTML = matrix.slice(0, 10).map((entry) => `<span>${escapeHtml(entry.browser)} ${escapeHtml(entry.device)} ${entry.status}</span>`).join("");
  artifactLinks.innerHTML = `
    ${artifactLink(job, "HTML report", "report.html")}
    ${artifactLink(job, "JSON report", "report.json")}
    ${artifactLink(job, "Developer summary", "developer-summary.md")}
    ${artifactLink(job, "Config", "audit-config.json")}
  `;

  if (activePreviewMode === "live") {
    stopCapturePlayback();
    renderLivePreview(job);
    return;
  }

  if (!finding) {
    stopCapturePlayback();
    previewTitle.textContent = "No findings detected";
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>No selected issue</strong>
        <span>The audit completed without element-level evidence to preview.</span>
      </div>
    `;
    return;
  }

  previewTitle.textContent = `${finding.id || ""} ${finding.title || "Finding"}`.trim();
  if (activePreviewMode === "captures") {
    renderCaptureReel(job, finding);
    return;
  }

  stopCapturePlayback();
  const evidence = finding.evidence || {};
  const preview = evidence.annotatedScreenshot || evidence.liveScreenshot;
  if (preview) {
    const extraEvidence = Array.isArray(evidence.annotatedScreenshots)
      ? evidence.annotatedScreenshots.filter((item) => item && item !== preview)
      : [];
    previewCanvas.className = "preview-canvas has-evidence";
    previewCanvas.innerHTML = `
      <div class="evidence-stage">
        <img src="${artifactUrl(job, preview)}" alt="Evidence preview for ${escapeHtml(finding.title || "finding")}">
        ${extraEvidence.length ? `
          <div class="evidence-strip" aria-label="Additional evidence crops">
            ${extraEvidence.slice(0, 5).map((item, index) => `
              <a href="${artifactUrl(job, item)}" target="_blank" rel="noreferrer">Crop ${index + 2}</a>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  } else {
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>No screenshot evidence</strong>
        <span>This finding is based on configuration, console, or network metadata.</span>
      </div>
    `;
  }
}

function findingEnvValues(finding, key) {
  return (finding.affectedEnvironments || []).map((env) => {
    if (key === "browser") return env.browser;
    if (key === "device") return env.device;
    return "";
  }).filter(Boolean);
}

function matchesFilters(finding) {
  return Object.entries(findingFilters).every(([key, value]) => {
    if (!value || value === "all") return true;
    if (key === "browser" || key === "device") return findingEnvValues(finding, key).includes(value);
    return String(finding[key] || finding.location?.[key] || "").toLowerCase() === String(value).toLowerCase();
  });
}

function renderReviewFilters(job, findings) {
  if (!reviewFilters) return;
  if (!job?.report || !findings.length) {
    reviewFilters.innerHTML = "";
    return;
  }
  const filterDefs = [
    ["severity", "Severity"],
    ["confidence", "Confidence"],
    ["source", "Source"],
    ["category", "Category"],
    ["section", "Section"],
    ["browser", "Browser"],
    ["device", "Device"],
    ["state", "State"],
  ];
  const optionsFor = (key) => {
    const values = new Set();
    for (const finding of findings) {
      if (key === "browser" || key === "device") {
        findingEnvValues(finding, key).forEach((value) => values.add(value));
      } else {
        const value = finding[key] || finding.location?.section;
        if (value) values.add(value);
      }
    }
    return Array.from(values).sort((a, b) => String(a).localeCompare(String(b)));
  };
  reviewFilters.innerHTML = filterDefs.map(([key, label]) => `
    <label>
      <span>${label}</span>
      <select data-filter="${key}">
        <option value="all">All</option>
        ${optionsFor(key).map((value) => `<option value="${escapeHtml(value)}" ${findingFilters[key] === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
      </select>
    </label>
  `).join("");
  reviewFilters.querySelectorAll("[data-filter]").forEach((select) => {
    select.addEventListener("change", () => {
      findingFilters[select.dataset.filter] = select.value;
      activeFindingIndex = 0;
      renderReportFromJob(job);
    });
  });
}

function renderFindingRail(job, findingsOverride = null) {
  const findings = findingsOverride || job?.report?.findings || [];
  findingRail.innerHTML = findings.length
    ? findings.map((finding, index) => {
        const severity = String(finding.severity || "medium").toLowerCase();
        return `
          <article class="issue-card ${severity} ${index === activeFindingIndex ? "active" : ""}" data-finding="${index}">
            <div class="issue-card-header">
              <span class="issue-id">${escapeHtml(finding.id || "QA")}</span>
              <span class="issue-category">${escapeHtml(finding.category || "Layout")}</span>
            </div>
            <h3 class="issue-title" title="${escapeHtml(finding.title || "")}">${escapeHtml(finding.title || "")}</h3>
            <div class="issue-card-footer">
              <span class="issue-location">📍 ${escapeHtml(finding.location?.section || "Page")}</span>
              <button class="open-details-btn" type="button" data-open-detail="${index}">Details →</button>
            </div>
          </article>
        `;
      }).join("")
    : `<div class="detail-empty">No issue cards yet.</div>`;

  findingRail.querySelectorAll("[data-finding]").forEach((item) => {
    item.addEventListener("click", () => {
      activeFindingIndex = Number(item.dataset.finding || 0);
      renderReportFromJob(job);
    });
  });

  findingRail.querySelectorAll("[data-open-detail]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      activeFindingIndex = Number(button.dataset.openDetail || 0);
      renderReportFromJob(job);
      openDetailDrawer();
    });
  });
}

function renderReportFromJob(job) {
  const allFindings = job?.report?.findings || [];
  renderReviewFilters(job, allFindings);
  const findings = allFindings.filter(matchesFilters);
  const selected = findings[activeFindingIndex] || findings[0] || null;
  renderPreview(job, selected);
  renderFindingRail(job, findings);
  renderDetailDrawerContent(job, selected);
}

function renderDetailDrawerContent(job, finding) {
  if (!detailDrawerContent) return;
  if (!finding) {
    detailDrawerContent.innerHTML = `<div class="detail-empty">No selected issue details.</div>`;
    return;
  }

  const severity = String(finding.severity || "medium").toLowerCase();
  detailDrawerContent.innerHTML = `
    <div class="detail-drawer-body">
      <div class="detail-drawer-meta">
        <span class="issue-id">${escapeHtml(finding.id || "QA")}</span>
        <span class="issue-severity-badge badge-${severity}">${escapeHtml(finding.severity || "medium")}</span>
      </div>
      
      <h2 class="detail-drawer-title">${escapeHtml(finding.title || "")}</h2>
      
      <div class="detail-section">
        <h4>Meta Information</h4>
        <p><strong>Category:</strong> ${escapeHtml(finding.category || "")}</p>
        <p><strong>Confidence:</strong> ${escapeHtml(finding.confidence || "medium")}</p>
        <p><strong>Source:</strong> ${escapeHtml(finding.source || "rule")}</p>
        <p><strong>State:</strong> ${escapeHtml(finding.state || "page-load")}</p>
        <p><strong>Affected Screens:</strong> ${finding.affectedCount || 0} environments</p>
      </div>

      ${finding.location || finding.section ? `
      <div class="detail-section">
        <h4>Location</h4>
        <p><strong>Section/Page:</strong> ${escapeHtml(finding.section || finding.location?.section || "Page")}</p>
        ${finding.location?.textSnippet ? `<p><strong>Text Snippet:</strong> <code>${escapeHtml(finding.location.textSnippet)}</code></p>` : ""}
        ${finding.location?.selector ? `<p><strong>Selector:</strong> <code>${escapeHtml(finding.location.selector)}</code></p>` : ""}
      </div>
      ` : ""}

      ${finding.measuredDelta ? `
      <div class="detail-section">
        <h4>Layout Deviation Measurements</h4>
        <pre><code>${escapeHtml(JSON.stringify(finding.measuredDelta, null, 2))}</code></pre>
      </div>
      ` : ""}

      <div class="detail-section">
        <h4>Actual Behavior</h4>
        <p class="description-text">${escapeHtml(finding.actual || "No description provided.")}</p>
      </div>

      <div class="detail-section">
        <h4>Suggested Fix</h4>
        <p class="description-text">${escapeHtml(finding.suggestedFix || "No suggested fix provided.")}</p>
      </div>

      <div class="detail-actions">
        ${finding.evidence?.annotatedScreenshot ? `<a class="run-button" href="${artifactUrl(job, finding.evidence.annotatedScreenshot)}" target="_blank" rel="noreferrer">Open highlighted crop</a>` : ""}
        ${finding.ticket ? `<a class="ghost" href="${artifactUrl(job, finding.ticket)}" target="_blank" rel="noreferrer">Open ticket</a>` : ""}
        ${finding.developerTicket ? `<button class="copy-ticket" type="button" id="copyDrawerTicketBtn">Copy ticket payload</button>` : ""}
      </div>
    </div>
  `;

  const copyBtn = detailDrawerContent.querySelector("#copyDrawerTicketBtn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(finding.developerTicket || "");
        copyBtn.textContent = "Copied Payload!";
        setTimeout(() => { copyBtn.textContent = "Copy ticket payload"; }, 1200);
      } catch {
        copyBtn.textContent = "Copy failed";
      }
    });
  }
}

function renderReport(job) {
  if (!job) {
    renderPreview(null, null);
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>No audit selected</strong>
        <span>Select a previous run from the history menu or submit a new audit.</span>
      </div>
    `;
    return;
  }

  if (!job.report) {
    previewTitle.textContent = job.status === "running" ? "Audit running" : "No report available";
    summaryPills.innerHTML = `<span>${escapeHtml(job.status)}</span><span>Waiting for report</span>`;
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview" style="width: 100%; height: 100%; display: grid; grid-template-rows: auto 1fr; padding: 24px; box-sizing: border-box; text-align: left; align-content: start;">
        <div style="margin-bottom: 16px;">
          <strong style="font-size: 16px; display: block; margin-bottom: 4px;">${job.status === "running" ? "Audit is running..." : "No report yet"}</strong>
          <span style="color: var(--soft); font-size: 12.5px;">Browser checks, screenshots, and findings will appear when the runner finishes.</span>
        </div>
        <pre style="margin: 0; background: rgba(0,0,0,0.3); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 12px; overflow: auto; font-family: 'Geist Mono', monospace; font-size: 11.5px; height: 100%; box-sizing: border-box; color: var(--muted);">${escapeHtml((job.log || []).join("\n"))}</pre>
      </div>
    `;
    artifactLinks.innerHTML = "";
    if (reviewFilters) reviewFilters.innerHTML = "";
    findingRail.innerHTML = `<div class="detail-empty">Waiting for findings.</div>`;
    return;
  }

  activeFindingIndex = Math.min(activeFindingIndex, Math.max(0, (job.report.findings || []).length - 1));
  renderReportFromJob(job);
}

async function refresh() {
  const jobs = await api("/api/jobs");
  renderJobs(jobs);
  if (activeJobId) {
    const job = await api(`/api/jobs/${encodeURIComponent(activeJobId)}`);
    renderReport(job);
    if (job.status !== "running" && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
}

async function selectJob(id) {
  try {
    activeJobId = id;
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    activeFindingIndex = Math.max(0, (job.report?.findings || []).findIndex((finding) => finding.evidence?.annotatedScreenshot));
    renderReport(job);
    closeDrawer();
  } catch (error) {
    formNote.textContent = `Could not open run: ${error.message}`;
    previewCanvas.className = "preview-canvas";
    previewCanvas.innerHTML = `
      <div class="empty-preview">
        <strong>Open failed</strong>
        <span>${escapeHtml(error.message)}</span>
      </div>
    `;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formNote.textContent = "Starting audit...";
  try {
    const payload = payloadFromForm();
    const warnings = parityWarnings(payload);
    if (warnings.length) {
      formNote.textContent = warnings.join(" ");
    }
    const job = await api("/api/audits", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    activeJobId = job.id;
    formNote.textContent = `Running ${job.id}`;
    renderReport(job);
    await refresh();
    location.hash = "report";
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 2000);
  } catch (error) {
    formNote.textContent = error.message;
  }
});

refreshJobs.addEventListener("click", () => refresh().catch((error) => {
  formNote.textContent = error.message;
}));

api("/api/health")
  .then((data) => {
    health.innerHTML = `
      <strong>Runner</strong><br>
      ${data.runnerExists ? "Ready" : "Missing runner"}<br>
      <span>${escapeHtml(data.auditWorkdirExists ? data.auditWorkdir : "Runtime fallback: workspace")}</span>
    `;
  })
  .catch((error) => {
    health.textContent = error.message;
  });

refresh().catch(() => {});

// Popover Navigation Drawer controller
const drawer = document.getElementById('drawer');
const openBtn = document.getElementById('drawer-open');
const closeBtn = document.getElementById('drawer-close');
const scroller = drawer?.querySelector('.Drawer-scroller');
const sheet = drawer?.querySelector('.Drawer-sheet');

function openDrawer() {
  if (!drawer || !scroller) return;
  drawer.showPopover();
  
  if (!CSS.supports('scroll-initial-target', 'nearest')) {
    scroller.scrollTo({left: scroller.offsetWidth, behavior: 'instant'});
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scroller.scrollTo({left: 0, behavior: 'auto'});
      });
    });
  } else {
    scroller.scrollTo({left: 0, behavior: 'auto'});
  }
}

function closeDrawer() {
  if (!scroller) return;
  scroller.scrollTo({left: scroller.offsetWidth, behavior: 'auto'});
}

function onDrawerOpened() {
  const workspaceEl = document.querySelector('.workspace');
  if (workspaceEl) workspaceEl.inert = true;
  if (drawer) drawer.inert = false;
  openBtn?.setAttribute('aria-expanded', 'true');
  sheet?.focus();
}

function onDrawerClosed() {
  drawer?.hidePopover();
  const workspaceEl = document.querySelector('.workspace');
  if (workspaceEl) workspaceEl.inert = false;
  openBtn?.setAttribute('aria-expanded', 'false');
}

if (drawer && scroller && sheet) {
  const visibleThreshold = 1 / window.innerWidth;
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1);
      if (entry.intersectionRatio < visibleThreshold) onDrawerClosed();
      if (entry.intersectionRatio === 1) onDrawerOpened();
    },
    {root: drawer, threshold: [visibleThreshold, 1]}
  );
  observer.observe(sheet);

  openBtn?.addEventListener('click', openDrawer);
  closeBtn?.addEventListener('click', closeDrawer);

  drawer.addEventListener('click', (event) => {
    if (!sheet.contains(event.target)) closeDrawer();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  if (!CSS.supports('animation-timeline: scroll()')) {
    scroller.addEventListener('scroll', () => {
      const ratio = 1 - scroller.scrollLeft / sheet.offsetWidth;
      drawer.style.setProperty('--drawer-backdrop', String(ratio));
    });
  }
}

// Premium Detail Drawer controller
function openDetailDrawer() {
  if (detailDrawer) {
    detailDrawer.showPopover();
  }
}

function closeDetailDrawer() {
  if (detailDrawer) {
    detailDrawer.hidePopover();
  }
}

if (detailDrawerClose) {
  detailDrawerClose.addEventListener("click", closeDetailDrawer);
}
