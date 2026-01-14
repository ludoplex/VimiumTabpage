const $ = id => document.getElementById(id);

document.addEventListener("DOMContentLoaded", function() {
  DomUtils.injectUserCss(); // Manually inject custom user styles.
  $("vimiumVersion").innerText = Utils.getCurrentVersion();

  chrome.storage.local.get("installDate", items => {
    if (items.installDate) {
      $("installDate").innerText = items.installDate.toString();
    }
  });

  // Use fetch instead of XMLHttpRequest for MV3 compatibility
  fetch(chrome.runtime.getURL(".git/HEAD"))
    .then(response => response.text())
    .then(text => {
      const branchRefParts = text.split("refs/heads/", 2);
      if (branchRefParts.length === 2)
        $("branchRef").innerText = branchRefParts[1];
      else
        $("branchRef").innerText = `HEAD detatched at ${branchRefParts[0]}`;
      $("branchRef-wrapper").classList.add("no-hide");
    })
    .catch(error => {
      console.log("Could not load .git/HEAD:", error);
    });
});
