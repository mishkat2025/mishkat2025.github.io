/* ============================================================
   Portfolio behaviour. Five small, independent pieces:
     1. theme toggle      2. mobile menu
     3. scroll reveal     4. active nav link
     5. copy-email + footer year
   Nothing here depends on a library.
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 1. Theme toggle ----------
     The <head> script already applied the saved theme before first paint,
     so there is no flash. This only handles clicks.
     localStorage can throw (private mode, blocked cookies), so every
     access is wrapped. */

  var STORAGE_KEY = "theme";

  function storedTheme() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function storeTheme(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* not fatal */ }
  }

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  var toggle = document.getElementById("themeToggle");

  if (toggle) {
    toggle.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme");

      // No explicit choice yet? Start from whatever the system is doing.
      if (!current) current = systemPrefersDark() ? "dark" : "light";

      var next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      storeTheme(next);
    });
  }


  /* ---------- 2. Mobile menu ---------- */

  var menuBtn = document.getElementById("menuBtn");
  var nav = document.getElementById("nav");

  function closeMenu() {
    if (!nav) return;
    nav.classList.remove("is-open");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }

  if (menuBtn && nav) {
    menuBtn.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });

    // Tapping a link should close the menu, not leave it hanging open.
    nav.addEventListener("click", function (event) {
      if (event.target.tagName === "A") closeMenu();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeMenu();
    });
  }


  /* ---------- 3. Scroll reveal ----------
     Elements with .reveal fade up once as they enter the viewport.
     IntersectionObserver is supported everywhere current; if it is
     missing we just show everything immediately. */

  var revealables = document.querySelectorAll(".reveal");

  if (!("IntersectionObserver" in window)) {
    for (var i = 0; i < revealables.length; i++) {
      revealables[i].classList.add("is-in");
    }
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        revealObserver.unobserve(entry.target);   // one-shot: never re-hide
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });

    revealables.forEach(function (el, index) {
      // Small stagger so siblings arrive in sequence rather than all at once.
      el.style.transitionDelay = (index % 4) * 60 + "ms";
      revealObserver.observe(el);
    });
  }


  /* ---------- 4. Active nav link + header border ---------- */

  var header = document.getElementById("siteHeader");
  var sections = document.querySelectorAll("main section[id]");
  var navLinks = document.querySelectorAll(".nav a");

  function setActive(id) {
    navLinks.forEach(function (link) {
      var matches = link.getAttribute("href") === "#" + id;
      link.classList.toggle("is-active", matches);
    });
  }

  if ("IntersectionObserver" in window && sections.length) {
    var navObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) setActive(entry.target.id);
      });
    }, { rootMargin: "-45% 0px -50% 0px" });

    sections.forEach(function (section) { navObserver.observe(section); });
  }

  if (header) {
    var onScroll = function () {
      header.classList.toggle("is-stuck", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }


  /* ---------- 5. Copy email + footer year ---------- */

  var copyBtn = document.getElementById("copyEmail");

  if (copyBtn && navigator.clipboard) {
    copyBtn.addEventListener("click", function () {
      var address = copyBtn.getAttribute("data-email");
      navigator.clipboard.writeText(address).then(function () {
        var original = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(function () { copyBtn.textContent = original; }, 1600);
      }).catch(function () {
        copyBtn.textContent = "Press Ctrl+C";
      });
    });
  } else if (copyBtn) {
    copyBtn.hidden = true;   // no clipboard API: hide rather than offer a dud
  }

  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

})();
