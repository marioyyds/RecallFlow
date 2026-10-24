(function () {
  "use strict";

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    reduceMotion = false;
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

    var rawLabel = button.getAttribute("aria-label") || button.textContent || "";
    var label = rawLabel.replace(/^(暂停|播放)动画：?/, "") || "演示";
    var frozen = false;
    var still = null;

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
      button.setAttribute("aria-label", (paused ? "播放动画：" : "暂停动画：") + label);
      button.textContent = paused ? "播放动画" : "暂停动画";
    }

    button.hidden = false;
    button.addEventListener("click", function () {
      try {
        setState(!frozen);
      } catch (error) {
        /* 渐进增强失败时保持原图播放，不影响页面 */
      }
    });

    if (reduceMotion && !img.complete) {
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
    } else if (reduceMotion) {
      try {
        setState(true);
      } catch (error) {
        /* 忽略：保持原图播放 */
      }
    }
  }

  try {
    var buttons = document.querySelectorAll(".gif-toggle");
    Array.prototype.forEach.call(buttons, function (button) {
      try {
        setupToggle(button);
      } catch (error) {
        /* 单个演示失败不影响其他演示 */
      }
    });
  } catch (error) {
    /* 增强脚本整体失败也不影响静态页面 */
  }
})();
