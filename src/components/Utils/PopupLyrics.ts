// deno-lint-ignore-file no-explicit-any
import Session from "../Global/Session.ts";
import PageView from "../Pages/PageView.ts";
import Fullscreen from "./Fullscreen.ts";
import { NPVCardOwnsPage, DeRenderNPVCard, RequestNPVCardEvaluate } from "./NPVLyrics.ts";

export let IsPIP = false;
export let _IsPIP_after = false;
// True for the whole PiP setup flow. The NPV card treats it as "page busy" so
// it can't re-take the pipeline during the long awaits (requestWindow, style
// fetches) before IsPIP itself is set.
export let IsPIPOpening = false;

let currentPipWindow = null;
let pipPageHideHandler: ((event: Event) => void) | null = null;

export const OpenPopupLyrics = async () => {
  IsPIPOpening = true;
  try {
    await OpenPopupLyricsFlow();
  } finally {
    IsPIPOpening = false;
    // If the flow failed or was cancelled, no page event fires — nudge the
    // card so it can come back.
    RequestNPVCardEvaluate();
  }
};

const OpenPopupLyricsFlow = async () => {
  // If the NPV card owns the page, tear it down directly — the guard below
  // would otherwise call Session.GoBack() and wrongly navigate the main view.
  if (NPVCardOwnsPage()) await DeRenderNPVCard();

  if (PageView.IsOpened && !IsPIP) {
    if (Fullscreen.IsOpen) {
      // If in any fullscreen mode, close it first
      await Fullscreen.Close();
      Session.GoBack();
    } else {
      await PageView.Destroy();
      Session.GoBack();
    }

    await OpenPopupLyricsFlow();
    return;
  }



  if (PageView.IsOpened) return;

  // Check for the Picture-in-Picture API
  // @ts-ignore: documentPictureInPicture is not yet standard
  const docPiP = globalThis.documentPictureInPicture;
  if (!docPiP || typeof docPiP.requestWindow !== "function") {
    throw new Error("documentPictureInPicture API is not available in this browser.");
  }

  // Open a Picture-in-Picture window.
  // @ts-ignore: requestWindow is not yet standard
  currentPipWindow = await docPiP.requestWindow({
    disallowReturnToOpener: true,
    preferInitialWindowPlacement: false,
    width: 390,
    height: 379,
  });

  // Copy style sheets over from the initial document
  // so that the player looks the same.
  // Only copy <link> elements with href starting with "https://fonts.spikerko.org" to the PiP window
  Array.from(document.querySelectorAll('link[rel="stylesheet"]')).forEach((link: HTMLLinkElement) => {
    const href = link.getAttribute("href") || "";
    const classList = Array.from(link.classList || []);
    const isFont = href.startsWith("https://fonts.spikerko.org");
    const isLocalCss = /^\/[a-zA-Z]{2}.*\.css$/.test(href);
    const isUserCss = (
      (href.endsWith("colors.css") || href.endsWith("user.css")) &&
      classList.length === 1 &&
      classList[0] === "userCSS"
    );
    if (
      link.href &&
      (isFont || isLocalCss || isUserCss)
    ) {
      const pipLink = document.createElement('link');
      pipLink.rel = 'stylesheet';
      pipLink.type = link.type || 'text/css';
      pipLink.media = link.media || '';
      pipLink.href = link.href;
      // Copy classes if it's a userCSS link
      if (isUserCss) {
        pipLink.className = link.className;
      }
      currentPipWindow.document.head.appendChild(pipLink);
    }
  });

  // Copy the main SpicyLyrics style element
  // Find any <style> element in the DOM that includes '#SpicyLyricsPage' in its textContent
  // Find all <style> elements in the DOM that include '#SpicyLyricsPage' in their textContent
  const spicyLyricsStyleElement = document.querySelector("#slstyles");
  let spicyLyricsStyleContent: string | null = null;

  if (spicyLyricsStyleElement) {
    if (spicyLyricsStyleElement.tagName.toLowerCase() === "link") {
      // @ts-ignore
      const href = spicyLyricsStyleElement.getAttribute("href");
      if (href) {
        try {
          const res = await fetch(href);
          if (res.ok) {
            spicyLyricsStyleContent = await res.text();
          }
        } catch (e) {
          spicyLyricsStyleContent = null;
        }
      }
    } else if (spicyLyricsStyleElement.tagName.toLowerCase() === "style") {
      spicyLyricsStyleContent = spicyLyricsStyleElement.textContent;
    }
  }

  if (spicyLyricsStyleContent) {
    const newStyleElement = document.createElement("style");
    newStyleElement.textContent = spicyLyricsStyleContent;
    currentPipWindow.document.head.appendChild(newStyleElement);
  }

  // Additionally, copy the styles element with the id 'spicyLyrics-additionalStyling'
  const additionalStyling = document.getElementById("spicyLyrics-additionalStyling");
  if (additionalStyling) {
    const newAdditionalStyling = document.createElement("style");
    newAdditionalStyling.id = "spicyLyrics-additionalStyling";
    newAdditionalStyling.textContent = additionalStyling.textContent;
    currentPipWindow.document.head.appendChild(newAdditionalStyling);
  }

  const additionalStylingElement = document.createElement("style");
  additionalStylingElement.textContent = `
    .app-drag-region {
      -webkit-app-region: drag;
      app-region: drag;
      position: fixed;
      height: 40px;
      inset: 0;
      width: 100cqw;
    }
    .spicy-pip-close {
      -webkit-app-region: no-drag;
      app-region: no-drag;
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 20;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.35);
      color: rgba(255, 255, 255, 0.9);
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 0.2s ease, background 0.2s ease;
    }
    body:hover .spicy-pip-close,
    .spicy-pip-close:focus-visible {
      opacity: 1;
    }
    .spicy-pip-close:hover {
      opacity: 1;
      background: rgba(0, 0, 0, 0.6);
    }
    .spicy-pip-close svg {
      width: 14px;
      height: 14px;
    }
  `.replace(/\s+/g, ' ').replace(/;\s*/g, ';').replace(/{\s*/g, '{').replace(/\s*}/g, '}').trim();

  currentPipWindow.document.head.appendChild(additionalStylingElement);

  currentPipWindow.document.body.innerHTML = `<div class="app-drag-region"></div><button class="spicy-pip-close" type="button" aria-label="Close popup lyrics" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button><div class="spicy-pip-wrapper"></div>`;

  const pipCloseButton = currentPipWindow.document.body.querySelector(".spicy-pip-close") as HTMLButtonElement | null;
  pipCloseButton?.addEventListener("click", () => {
    ClosePopupLyrics();
  });

  const pipWrapper = currentPipWindow.document.body.querySelector(".spicy-pip-wrapper") as HTMLElement;

  IsPIP = true;

  PageView.Open(pipWrapper);

  Fullscreen.Open(true, false);

  pipPageHideHandler = () => {
    // deno-lint-ignore no-window
    window.location.reload();
  };

  currentPipWindow.addEventListener("pagehide", pipPageHideHandler);

  _IsPIP_after = true;
};

export const ClosePopupLyrics = async () => {
  if (!IsPIP || !currentPipWindow) return;
  _IsPIP_after = false;

  await Fullscreen.Close(true)
  await PageView.Destroy();

  // Remove the event listener before closing the window
  if (pipPageHideHandler) {
    currentPipWindow.removeEventListener("pagehide", pipPageHideHandler);
    pipPageHideHandler = null;
  }

  currentPipWindow.close()

  currentPipWindow = null;

  IsPIP = false
}
