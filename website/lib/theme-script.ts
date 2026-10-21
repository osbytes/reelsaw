export const THEME_KEY = "rs-theme";

// Runs before first paint. React's commitHostSingletonAcquisition (hydration
// recovery, and Strict Mode's remount in dev) then strips every attribute on
// <html> that JSX does not own, which drops data-theme and leaves the light
// palette. The observer puts the stored choice back; pageshow covers bfcache,
// which restores the old document without re-running this script.
export const THEME_BOOT_SCRIPT = `(function(){if(window.__rsThemeBoot)return;window.__rsThemeBoot=1;var k=${JSON.stringify(THEME_KEY)};function pref(){try{var t=localStorage.getItem(k);if(t==="dark"||t==="light")return t}catch(e){}try{return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){return"light"}}function apply(){var el=document.documentElement;if(!el)return;var t=pref();if(el.getAttribute("data-theme")===t)return;el.setAttribute("data-theme",t);try{dispatchEvent(new Event("rs-theme"))}catch(e){}}apply();new MutationObserver(apply).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});addEventListener("pageshow",apply)})();`;
