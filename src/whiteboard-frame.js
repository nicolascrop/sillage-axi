// Adapted from Lavish AXI; see THIRD-PARTY-NOTICES.md and docs/whiteboards.md.
// Opaque-origin local editor: the parent owns all HTTP and exact revision identity.

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import {
  convertToExcalidrawElements,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  exportToCanvas,
  FONT_FAMILY,
  restore,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./whiteboard-frame.css";

import {
  convertExcalidrawSkeletonsAfterFontsLoad,
  createWhiteboardPersistencePayload,
  prepareExcalidrawSkeletons,
  repairSavedSceneTextMetrics,
  sanitizeWhiteboardAppState,
  sceneIsImageFallback,
  WHITEBOARD_TEXT_METRICS_VERSION,
} from "./whiteboard-core.js";

const SAVE_DEBOUNCE_MS = 800;

const state = {
  mode: "overlay",
  diagramIndex: 0,
  diagramId: "",
  // Source hash stays bound to the exact displayed report revision. A live
  // update never relabels this editor or its feedback as the latest revision.
  sceneSourceHash: "",
  baselineElements: [],
  files: {},
  imageFallback: false,
  textMetricsVersion: WHITEBOARD_TEXT_METRICS_VERSION,
  channelId: "",
  api: null,
  saveTimer: 0,
  flushIds: new Set(),
  queueBusy: false,
  feedbackKey: "",
  feedbackPayload: null,
  revisionId: null,
  locked: true,
  // Inline frames boot locked (view mode) so a page full of embedded
  // whiteboards scrolls normally; the first click on the canvas unlocks it.
  setLocked: null,
};

function post(message) {
  window.top.postMessage(
    {
      ...message,
      diagramIndex: state.diagramIndex,
      channelId: state.channelId,
    },
    "*",
  );
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function setBanner(id, text) {
  const banner = document.getElementById(id);
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = !text;
}

function buildShell(theme, mode) {
  document.body.dataset.sillageWhiteboardTheme = theme;
  document.body.dataset.sillageWhiteboardMode = mode;
  const shell = el("div", { id: "wbShell" });
  const header = el("header", { id: "wbHeader" });
  const title = el("div", { id: "wbTitle", textContent: "Whiteboard" });
  const note = el("input", {
    id: "wbNote",
    placeholder: "Optional note for the agent about these edits...",
    autocomplete: "off",
    maxLength: 2000,
    ariaLabel: "Optional feedback note (2,000 characters)",
  });
  const queueButton = el("button", { id: "wbQueue", type: "button", textContent: "Send feedback" });
  // In overlay mode the chrome renders the close control on top of this
  // header's right edge (it must work even when this frame fails to boot), so
  // the header reserves that space via CSS instead of adding its own close.
  // Inline frames offer a fullscreen action instead, which asks the chrome to
  // reopen this diagram in the overlay.
  const viewButton = el("button", { id: "wbView", type: "button", textContent: "View / scroll" });
  viewButton.onclick = () => state.setLocked?.(true);
  const fitButton = el("button", { id: "wbFit", type: "button", textContent: "Fit" });
  fitButton.onclick = fitScene;
  header.append(title, viewButton, note, queueButton, fitButton);
  if (mode === "inline") {
    const fullscreenButton = el("button", {
      id: "wbFullscreen",
      type: "button",
      textContent: "Fullscreen",
      title: "Open this whiteboard full screen",
    });
    fullscreenButton.onclick = () => post({ type: "sillage-whiteboard:maximize", diagramIndex: state.diagramIndex });
    header.append(fullscreenButton);
  }
  const fallbackBanner = el("div", { id: "wbFallbackBanner", className: "wb-banner", hidden: true });
  const staleBanner = el("div", { id: "wbStaleBanner", className: "wb-banner wb-banner-warn", hidden: true });
  const status = el("div", { id: "wbStatus", className: "wb-status", hidden: true });
  const editor = el("div", { id: "wbEditor" });
  const disclosure = el("div", { className: "wb-delivery", textContent: "Saved locally. Send delivers a bounded text/geometry summary, not drawing pixels. Add a note to explain freehand or style edits. Mermaid source stays authoritative." });
  shell.append(header, fallbackBanner, staleBanner, status, editor, disclosure);
  document.body.append(shell);

  queueButton.onclick = () => queueFeedback().catch((error) => showStatus(`Queue failed: ${describeError(error)}`));
  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      queueButton.click();
    }
  });
}

let statusTimer = 0;
function showStatus(text, { transient = true } = {}) {
  const status = document.getElementById("wbStatus");
  if (!status) return;
  status.textContent = text;
  status.hidden = !text;
  if (transient && text) {
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.hidden = true;
    }, 4000);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function currentScene() {
  if (!state.api) return null;
  const appState = state.api.getAppState();
  return {
    elements: state.api.getSceneElements().map((element) => JSON.parse(JSON.stringify(element))),
    appState: sanitizeWhiteboardAppState({
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    }),
    files: state.api.getFiles() || {},
  };
}

function postSave(flushId = "") {
  const scene = currentScene();
  if (!scene) return false;
  const payload = createWhiteboardPersistencePayload(state, scene);
  const fingerprint = JSON.stringify(payload);
  if (!flushId && fingerprint === state.lastPostedPayload) return true;
  state.lastPostedPayload = fingerprint;
  post({
    type: "sillage-whiteboard:save",
    diagramIndex: state.diagramIndex,
    ...payload,
    ...(flushId ? { flushId } : {}),
  });
  return true;
}

function scheduleSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    postSave();
  }, SAVE_DEBOUNCE_MS);
}

function flushSaveNow(message) {
  const flushId = String(message.flushId || "");
  if (!flushId || state.flushIds.has(flushId)) return;
  state.flushIds.add(flushId);
  window.clearTimeout(state.saveTimer);
  if (!postSave(flushId)) {
    state.flushIds.delete(flushId);
    post({ type: "sillage-whiteboard:flushComplete", flushId, ok: true });
  }
}

function handleSaveResult(message) {
  const flushId = String(message.flushId || "");
  if (!message.ok) {
    state.lastPostedPayload = "";
    showStatus(`Save failed: ${String(message.error || "local service unavailable")}. Keep this tab open; retry after reconnecting.`, { transient: false });
  }
  // The parent owns the persistent saved indicator. Toggling a transient banner
  // here would resize the canvas and trigger another autosave on every idle poll.
  if (!flushId) return;
  if (state.flushIds.delete(flushId)) {
    post({ type: "sillage-whiteboard:flushComplete", flushId, ok: Boolean(message.ok) });
  }
}

function onLinkOpen(element, event) {
  event.preventDefault();
  showStatus("Diagram links are disabled in this local-only whiteboard.");
}

// Inline frames start locked in view mode behind a click-catcher: a page of
// embedded whiteboards must scroll like a page, not trap every wheel event in
// canvas zoom. The first click unlocks this one editor.
function EditorApp({ elements, appState, files, theme, startLocked }) {
  const [locked, setLocked] = React.useState(startLocked);
  state.setLocked = (value) => {
    state.locked = value;
    setLocked(value);
    post({ type: "sillage-whiteboard:mode", editing: !value });
    if (value) postSave();
  };
  React.useEffect(() => { post({ type: "sillage-whiteboard:mode", editing: !locked }); }, [locked]);
  return React.createElement(
    "div",
    { style: { position: "relative", width: "100%", height: "100%" } },
    React.createElement(Excalidraw, {
      initialData: { elements, appState, files: files || undefined, scrollToContent: true },
      theme,
      langCode: "en",
      aiEnabled: false,
      viewModeEnabled: locked,
      onChange: scheduleSave,
      onLinkOpen,
      validateEmbeddable: () => false,
      renderTopRightUI: () => null,
      excalidrawAPI: (api) => {
        state.api = api;
        post({ type: "sillage-whiteboard:mounted", imageFallback: state.imageFallback });
        // Fit the whole scene into the frame - inline frames are far smaller
        // than the scene's natural 100% size, and a zoomed-in corner of a
        // diagram reads as broken.
        window.setTimeout(() => {
          try {
            api.scrollToContent(api.getSceneElements(), { fitToContent: true });
          } catch {
            // scrollToContent is cosmetic; initialData already centered us.
          }
        }, 0);
      },
      UIOptions: {
        tools: { image: false },
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: false,
          export: false,
          saveAsImage: false,
        },
      },
    }, React.createElement(MainMenu, null, React.createElement(MainMenu.DefaultItems.ClearCanvas)),
    React.createElement(WelcomeScreen, null)),
    locked
      ? React.createElement(
          "div",
          {
            className: "wb-activate",
            role: "button",
            tabIndex: 0,
            onClick: () => state.setLocked(false),
            onKeyDown: (event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); state.setLocked(false); }
            },
          },
          React.createElement("span", { className: "wb-activate-label" }, "Click to edit"),
        )
      : null,
  );
}

function fitScene() {
  if (!state.api) return;
  try { state.api.scrollToContent(state.api.getSceneElements(), { fitToContent: true }); }
  catch { /* A transient resize does not discard the scene. */ }
}
function mountEditor({ elements, appState, files, theme }) {
  const editorHost = document.getElementById("wbEditor");
  const root = createRoot(editorHost);
  let resizeTimer;
  new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (state.locked) fitScene(); }, 100);
  }).observe(editorHost);
  root.render(
    React.createElement(EditorApp, {
      elements,
      appState,
      files,
      theme,
      startLocked: state.mode === "inline",
    }),
  );
}

const textMetricsCanvas = document.createElement("canvas");
const textMetricsContext = textMetricsCanvas.getContext("2d");

function fontFamilyName(fontFamily) {
  return Object.entries(FONT_FAMILY).find(([, value]) => value === fontFamily)?.[0] || "Segoe UI Emoji";
}

function fontString(element) {
  const family = fontFamilyName(element.fontFamily);
  const families = family === "Excalifont" ? [family, "Xiaolai", "Segoe UI Emoji"] : [family, "Segoe UI Emoji"];
  return `${Number(element.fontSize) || 20}px ${families.map((value) => JSON.stringify(value)).join(", ")}`;
}

function measureSceneText(element) {
  if (!textMetricsContext) return { width: Number(element.width) || 0, height: Number(element.height) || 0 };
  textMetricsContext.font = fontString(element);
  const lines = String(element.text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "        ")
    .split("\n");
  const width = Math.max(...lines.map((line) => textMetricsContext.measureText(line || " ").width));
  const height = lines.length * (Number(element.fontSize) || 20) * (Number(element.lineHeight) || 1.25);
  return { width, height };
}

async function loadSceneFonts(elements, files) {
  const textElements = elements.filter((element) => element.type === "text" && !element.isDeleted);
  if (textElements.length === 0) return;
  await exportToCanvas({
    elements,
    appState: { exportBackground: false },
    files: files || null,
    maxWidthOrHeight: 1,
  });
  await Promise.all(
    textElements.map((element) => document.fonts.load(fontString(element), String(element.text || ""))),
  );
  await document.fonts.ready;
}

async function convertSource(source) {
  if (source.length > 100_000) throw new Error("Diagram exceeds the 100,000-character whiteboard conversion limit; original source is available below.");
  const { elements: parsedSkeletons, files } = await parseMermaidToExcalidraw(source, {
    themeVariables: { fontSize: "16px" },
  });
  const skeletons = prepareExcalidrawSkeletons(parsedSkeletons);
  const materialize = (input) => convertToExcalidrawElements(input, { regenerateIds: false });
  const elements = await convertExcalidrawSkeletonsAfterFontsLoad(skeletons, {
    convert: materialize,
    loadFonts: async (fallbackElements) => {
      await loadSceneFonts(fallbackElements, files);
    },
  });
  return { elements, files: files || {}, imageFallback: sceneIsImageFallback(elements) };
}

// Theme is passed only through the <Excalidraw theme> prop - putting it in
// appState as well double-applies the dark-mode invert filter and washes the
// canvas out. The background stays a light paper color in both themes; dark
// mode derives its rendering from it via Excalidraw's own filter.
function defaultAppState() {
  return {
    viewBackgroundColor: "#ffffff",
  };
}

async function startFromConversion(init) {
  const { elements, files, imageFallback } = await convertSource(init.source);
  state.baselineElements = JSON.parse(JSON.stringify(elements));
  state.files = files;
  state.imageFallback = imageFallback;
  state.sceneSourceHash = init.sourceHash;
  state.textMetricsVersion = WHITEBOARD_TEXT_METRICS_VERSION;
  if (imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({ elements, appState: defaultAppState(), files, theme: init.theme });
  scheduleSave();
}

async function startFromSavedScene(init) {
  const saved = init.saved;
  const savedAppState = sanitizeWhiteboardAppState(saved.scene?.appState);
  // restore() is Excalidraw's defensive loader: it fills missing fields with
  // defaults and repairs bindings, so a stale or hand-edited sidecar cannot
  // crash the editor.
  const restored = restore(
    {
      elements: Array.isArray(saved.scene?.elements) ? saved.scene.elements : [],
      appState: savedAppState,
      files: saved.scene?.files || {},
    },
    null,
    null,
    { repairBindings: true },
  );
  let elements = restored.elements;
  let baselineElements = Array.isArray(saved.baseline?.elements)
    ? JSON.parse(JSON.stringify(saved.baseline.elements))
    : JSON.parse(JSON.stringify(restored.elements));
  state.files = restored.files || saved.scene?.files || {};
  const savedMetricsVersion = Number(saved.text_metrics_version) || 0;
  if (savedMetricsVersion < WHITEBOARD_TEXT_METRICS_VERSION) {
    await loadSceneFonts(elements, state.files);
    elements = repairSavedSceneTextMetrics(elements, { measure: measureSceneText }).elements;
    baselineElements = repairSavedSceneTextMetrics(baselineElements, { measure: measureSceneText }).elements;
  }
  state.baselineElements = baselineElements;
  state.textMetricsVersion = WHITEBOARD_TEXT_METRICS_VERSION;
  // Annotations may add native shapes on top of an image. The conversion
  // baseline, not the edited scene, still determines the fallback disclosure.
  state.imageFallback = sceneIsImageFallback(baselineElements);
  state.sceneSourceHash = saved.source_hash || init.sourceHash;
  if (state.imageFallback) {
    setBanner(
      "wbFallbackBanner",
      "This diagram type is not natively editable, so it is shown as an image - draw, annotate, and add shapes on top.",
    );
  }
  mountEditor({
    elements,
    appState: { ...defaultAppState(), ...savedAppState },
    files: state.files,
    theme: init.theme,
  });
  if (savedMetricsVersion < WHITEBOARD_TEXT_METRICS_VERSION) scheduleSave();
}

async function queueFeedback() {
  if (!state.api || state.queueBusy) return;
  state.queueBusy = true;
  const queueButton = /** @type {HTMLButtonElement} */ (document.getElementById("wbQueue"));
  queueButton.disabled = true;
  queueButton.textContent = "Sending...";
  try {
    const scene = currentScene();
    const note = document.getElementById("wbNote");
    note.disabled = true;
    state.feedbackPayload ||= {
      type: "sillage-whiteboard:queueFeedback",
      diagramIndex: state.diagramIndex,
      diagramId: state.diagramId,
      ...createWhiteboardPersistencePayload(state, scene),
      imageFallback: state.imageFallback,
      note: String(/** @type {HTMLInputElement} */ (document.getElementById("wbNote")).value || "").trim(),
      clientKey: state.feedbackKey ||= crypto.randomUUID(),
    };
    post(state.feedbackPayload);
  } catch (error) {
    resetQueueButton();
    throw error;
  }
}

function resetQueueButton() {
  state.queueBusy = false;
  const queueButton = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbQueue"));
  if (queueButton) {
    queueButton.disabled = false;
    queueButton.textContent = state.feedbackPayload ? "Retry same feedback" : "Send feedback";
  }
}

async function handleInit(init) {
  state.revisionId = init.revisionId;
  state.expanded = Boolean(init.expanded);
  state.mode = init.mode === "inline" ? "inline" : "overlay";
  state.diagramIndex = Number(init.diagramIndex) || 0;
  state.diagramId = String(init.diagramId || "");
  const theme = init.theme === "dark" ? "dark" : "light";
  document.getElementById("wbTitle").textContent = `Diagram ${state.diagramIndex + 1} · revision ${state.revisionId}`;

  const saved = init.saved && typeof init.saved === "object" && init.saved.scene ? init.saved : null;
  try {
    if (!saved) {
      await startFromConversion({ ...init, theme });
      return;
    }
    if (saved.source_hash === init.sourceHash) {
      await startFromSavedScene({ ...init, saved, theme });
      return;
    }
    throw new Error("Saved scene does not match this exact revision. Open Whiteboard history; never merge stale sources.");
  } catch (error) {
    showStatus(`Could not open this diagram as a whiteboard: ${describeError(error)}`, { transient: false });
    post({ type: "sillage-whiteboard:conversionError", error: "Could not convert this Mermaid diagram. Original source is preserved below. " + describeError(error).slice(0, 500) });
  }
}

function focusableControls() {
  return [...document.querySelectorAll('button,input,textarea,select,a,[tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length);
}
function main() {
  // location.origin still identifies the embedding HTTP URL even in the opaque sandbox.
  window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;
  document.addEventListener("click", event => {
    if (event.target.closest?.("a")) { event.preventDefault(); event.stopImmediatePropagation(); showStatus("Links are disabled in this local-only whiteboard."); }
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Tab" && state.expanded) {
      const controls = focusableControls();
      if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
        event.preventDefault();
        post({ type: "sillage-whiteboard:tabBoundary", reverse: event.shiftKey });
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.setLocked?.(true);
      post({ type: "sillage-whiteboard:close" });
    }
  });
  const frameUrl = new URL(location.href);
  const diagramIndex = Number(frameUrl.searchParams.get("diagramIndex"));
  state.diagramIndex = Number.isInteger(diagramIndex) && diagramIndex >= 0 && diagramIndex <= 999 ? diagramIndex : 0;
  state.diagramId = String(frameUrl.searchParams.get("diagramId") || "");
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (event.source !== window.top) return;
    const msg = event.data || {};
    if (msg.type === "sillage-whiteboard:init" && !initialized && typeof msg.channelId === "string" && msg.channelId) {
      initialized = true;
      state.channelId = msg.channelId;
      buildShell(msg.theme === "dark" ? "dark" : "light", msg.mode === "inline" ? "inline" : "overlay");
      handleInit(msg);
    }
    if (!initialized || msg.channelId !== state.channelId) return;
    if (msg.type === "sillage-whiteboard:inherited") setBanner("wbStaleBanner", `Annotations carried from revision ${msg.revisionId}: exact, unambiguous Mermaid source match. Feedback will cite revision ${state.revisionId}.`);
    if (msg.type === "sillage-whiteboard:staleRevision") setBanner("wbStaleBanner", `Report updated to revision ${msg.revisionId}. This editor stays on revision ${state.revisionId}; no reattachment. Choose View / scroll or close to display the latest report. Saved scenes remain in Whiteboard history.`);
    if (msg.type === "sillage-whiteboard:lock") state.setLocked?.(msg.locked !== false);
    if (msg.type === "sillage-whiteboard:focusLast") focusableControls().at(-1)?.focus();
    if (msg.type === "sillage-whiteboard:expanded") {
      state.expanded = Boolean(msg.value);
      window.setTimeout(fitScene, 150);
    }
    if (msg.type === "sillage-whiteboard:flush") flushSaveNow(msg);
    if (msg.type === "sillage-whiteboard:saveResult") handleSaveResult(msg);
    if (msg.type === "sillage-whiteboard:queueResult") {
      resetQueueButton();
      if (msg.ok) {
        const note = /** @type {HTMLInputElement | null} */ (document.getElementById("wbNote"));
        if (note) { note.value = ""; note.disabled = false; }
        state.feedbackKey = "";
        state.feedbackPayload = null;
        resetQueueButton();
        showStatus("Feedback saved in the existing local conversation queue. The agent receives a bounded summary, not drawing pixels.", { transient: false });
      } else {
        showStatus(`Queue failed: ${String(msg.error || "unknown error")}`, { transient: false });
      }
    }
  });
  post({ type: "sillage-whiteboard:ready" });
}

main();
