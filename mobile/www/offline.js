// "Try again": reload the Honest OS deployment. config.js (written by scripts/www-config.mjs
// at `cap sync`) sets window.HONEST_SERVER_URL; without it, go back to the page that failed.
(function () {
  var button = document.getElementById("retry");
  if (!button) return;
  button.addEventListener("click", function () {
    var url = window.HONEST_SERVER_URL;
    if (typeof url === "string" && /^https:\/\//.test(url)) window.location.replace(url);
    else if (window.history.length > 1) window.history.back();
    else window.location.reload();
  });
})();
