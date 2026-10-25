(function () {
  "use strict";

  // 字典由 i18n.js 提供（defer + 顺序在前，这里一定能拿到）。
  // 拿不到时整段增强静默失效：页面停留在 index.html 的英文静态内容，不会白屏。
  var i18n = window.RecallFlowI18n;
  var lang = i18n ? i18n.detect() : "en";

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    reduceMotion = false;
  }

  // 所有「不在 HTML 里、由脚本写出来的可见文案」都要在语言切换后重贴一遍。
  // 每处把自己的重贴函数登记进来，切语言时统一跑一遍。
  var relabelers = [];

  function text(key, params) {
    return i18n ? i18n.text(lang, key, params) : "";
  }

  function demoName(button) {
    var key = button.getAttribute("data-demo-name");
    var name = key ? text(key) : "";
    return name || text("demo.fallbackName");
  }

  function freezeFrame(img, media) {
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
      return null;
    }
    var canvas = document.createElement("canvas");
    canvas.className = "demo-still";
    canvas.width = img.naturalWidth || 960;
    canvas.height = img.naturalHeight || 540;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", img.getAttribute("alt") || "");
    var ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    try {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } catch (error) {
      return null;
    }
    media.insertBefore(canvas, img);
    media.classList.add("is-frozen");
    return canvas;
  }

  function setupToggle(button) {
    var media = button.closest(".demo-media");
    var img = media ? media.querySelector(".demo-gif") : null;
    if (!media || !img) {
      return;
    }

    var frozen = false;
    var still = null;

    // 按钮文字与 aria-label 都来自字典；`{name}` 是演示名（各语言的演示标题）。
    function relabel() {
      if (!i18n) {
        return;
      }
      var name = demoName(button);
      var label = frozen ? text("demo.playLabel", { name: name }) : text("demo.pauseLabel", { name: name });
      button.setAttribute("aria-label", label || name);
      button.textContent = frozen ? text("demo.play") : text("demo.pause");
      if (still) {
        still.setAttribute("aria-label", img.getAttribute("alt") || "");
      }
    }

    function setState(paused) {
      if (paused && !frozen) {
        still = freezeFrame(img, media);
        if (!still) {
          return;
        }
        frozen = true;
      } else if (!paused && frozen) {
        media.classList.remove("is-frozen");
        if (still && still.parentNode) {
          still.parentNode.removeChild(still);
        }
        still = null;
        frozen = false;
        img.src = img.getAttribute("src");
      }
      button.setAttribute("aria-pressed", paused ? "true" : "false");
      relabel();
    }

    button.hidden = false;
    button.addEventListener("click", function () {
      try {
        setState(!frozen);
      } catch (error) {
        /* 渐进增强失败时保持原图播放，不影响页面 */
      }
    });

    relabelers.push(relabel);
    relabel();

    if (reduceMotion) {
      if (img.complete && img.naturalWidth > 0) {
        try {
          setState(true);
        } catch (error) {
          /* 忽略：保持原图播放 */
        }
      } else {
        img.addEventListener(
          "load",
          function () {
            try {
              setState(true);
            } catch (error) {
              /* 忽略：保持原图播放 */
            }
          },
          { once: true }
        );
      }
    }
  }

  function setLang(next) {
    if (!i18n) {
      return;
    }
    // i18n.apply 会把整页回填到目标语言并更新 <html lang> / <title> / meta；
    // 之后再把脚本自己写出来的文案重贴一遍。
    lang = i18n.switchTo(next);
    for (var i = 0; i < relabelers.length; i += 1) {
      relabelers[i]();
    }
  }

  function wireLangSwitch() {
    if (!i18n) {
      return;
    }
    var buttons = document.querySelectorAll("[data-lang]");
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener("click", function () {
        setLang(button.getAttribute("data-lang"));
      });
    });
  }

  try {
    if (i18n) {
      i18n.apply(lang);
    }
    var buttons = document.querySelectorAll(".gif-toggle");
    Array.prototype.forEach.call(buttons, function (button) {
      try {
        setupToggle(button);
      } catch (error) {
        /* 单个演示失败不影响其他演示 */
      }
    });
    wireLangSwitch();
  } catch (error) {
    /* 增强脚本整体失败也不影响静态页面 */
  }
})();
