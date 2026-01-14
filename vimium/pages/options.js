const $ = id => document.getElementById(id);

// In MV3, we cannot use chrome.extension.getBackgroundPage()
// Instead, we use Settings directly on this page (which loads via chrome.storage)
// and communicate with the background service worker via messages when needed.

// For Exclusions, we'll use a local implementation that syncs with storage
let bgExclusions = null;
let bgSettings = null;

// Initialize settings and exclusions
const initBackgroundAccess = async () => {
  // Wait for Settings to be loaded
  return new Promise((resolve) => {
    Settings.onLoaded(() => {
      bgSettings = Settings;
      // Exclusions should be available after Settings loads
      if (typeof Exclusions !== 'undefined') {
        bgExclusions = Exclusions;
      } else {
        // Create a minimal Exclusions object for the popup
        bgExclusions = {
          RegexpCache: {
            get(pattern) {
              try {
                return new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
              } catch (e) {
                return new RegExp(pattern);
              }
            }
          },
          getRule(url, rules) {
            for (let rule of (rules || [])) {
              if (url.match(this.RegexpCache.get(rule.pattern))) {
                return rule;
              }
            }
            return null;
          },
          isEnabledForUrl(url) {
            const rules = Settings.get("exclusionRules") || [];
            const rule = this.getRule(url, rules);
            return {
              isEnabledForUrl: !rule || rule.passKeys,
              passKeys: rule ? rule.passKeys : ""
            };
          }
        };
      }
      resolve();
    });
  });
};

//
// Class hierarchy for various types of option.
// Call "fetch" after constructing an Option object, to fetch it from localStorage.
class Option {
  // Base class for all option classes.
  // Abstract. Option does not define @populateElement or @readValueFromElement.
  constructor(field, onUpdated) {
    this.field = field;
    this.onUpdated = onUpdated;
    this.element = $(this.field);
    this.element.addEventListener("change", this.onUpdated);
    Option.all.push(this);
  }

  // Fetch a setting from localStorage, remember the @previous value and populate the DOM element.
  // Return the fetched value.
  fetch() {
    this.populateElement(this.previous = bgSettings.get(this.field));
    return this.previous;
  }

  // Write this option's new value back to localStorage, if necessary.
  save() {
    const value = this.readValueFromElement();
    if (JSON.stringify(value) !== JSON.stringify(this.previous))
      bgSettings.set(this.field, (this.previous = value));
  }

  restoreToDefault() {
    bgSettings.clear(this.field);
    return this.fetch();
  }

  static onSave(callback) {
    this.onSaveCallbacks.push(callback);
  }

  // Static method.
  static saveOptions() {
    Option.all.map(option => option.save());
    this.onSaveCallbacks.map((callback) => callback());
  }
}

  // Abstract method; only implemented in sub-classes.
  // Populate the option's DOM element (@element) with the setting's current value.
  // populateElement: (value) -> DO_SOMETHING

  // Abstract method; only implemented in sub-classes.
  // Extract the setting's new value from the option's DOM element (@element).
  // readValueFromElement: -> RETURN_SOMETHING

Option.all = []; // Static. Array of all options.
Option.onSaveCallbacks = [];

class NumberOption extends Option {
  populateElement(value) { this.element.value = value; }
  readValueFromElement() { return parseFloat(this.element.value); }
}

class TextOption extends Option {
  constructor(...args) {
    super(...Array.from(args || []));
    this.element.addEventListener("input", this.onUpdated);
  }
  populateElement(value) { this.element.value = value; }
  readValueFromElement() { return this.element.value.trim(); }
}

class NonEmptyTextOption extends Option {
  constructor(...args) {
    super(...Array.from(args || []));
    this.element.addEventListener("input", this.onUpdated);
  }

  populateElement(value) { this.element.value = value; }
  // If the new value is not empty, then return it. Otherwise, restore the default value.
  readValueFromElement() {
    const value = this.element.value.trim();
    if (value)
      return value;
    else
      return this.restoreToDefault();
  }
}

class CheckBoxOption extends Option {
  populateElement(value) { this.element.checked = value; }
  readValueFromElement() { return this.element.checked; }
}

class ExclusionRulesOption extends Option {
  constructor(...args) {
    super(...Array.from(args || []));
    $("exclusionAddButton").addEventListener("click", event => {
      this.addRule();
    });
  }

  // Add a new rule, focus its pattern, scroll it into view, and return the newly-added element.  On the
  // options page, there is no current URL, so there is no initial pattern.  This is the default.  On the popup
  // page (see ExclusionRulesOnPopupOption), the pattern is pre-populated based on the current tab's URL.
  addRule(pattern) {
    if (pattern == null)
      pattern = "";
    const element = this.appendRule({ pattern, passKeys: "" });
    this.getPattern(element).focus();
    const exclusionScrollBox = $("exclusionScrollBox");
    exclusionScrollBox.scrollTop = exclusionScrollBox.scrollHeight;
    this.onUpdated();
    return element;
  }

  populateElement(rules) {
    // For the case of restoring a backup, we first have to remove existing rules.
    const exclusionRules = $("exclusionRules");
    while (exclusionRules.rows[1]) { exclusionRules.deleteRow(1); }
    for (let rule of rules)
      this.appendRule(rule);
  }

  // Append a row for a new rule.  Return the newly-added element.
  appendRule(rule) {
    let element;
    const content = document.querySelector('#exclusionRuleTemplate').content;
    const row = document.importNode(content, true);

    for (let field of ["pattern", "passKeys"]) {
      element = row.querySelector(`.${field}`);
      element.value = rule[field];
      for (let event of [ "input", "change" ])
        element.addEventListener(event, this.onUpdated);
    }

    this.getRemoveButton(row).addEventListener("click", event => {
      rule = event.target.parentNode.parentNode;
      rule.parentNode.removeChild(rule);
      this.onUpdated();
    });

    this.element.appendChild(row);
    return this.element.children[this.element.children.length-1];
  }

  readValueFromElement() {
    const rules =
      Array.from(this.element.getElementsByClassName("exclusionRuleTemplateInstance")).map((element) => ({
        pattern: this.getPattern(element).value.trim(),
        passKeys: this.getPassKeys(element).value.trim()
      }));
    return rules.filter(rule => rule.pattern);
  }

  // Accessors for the three main sub-elements of an "exclusionRuleTemplateInstance".
  getPattern(element) { return element.querySelector(".pattern"); }
  getPassKeys(element) { return element.querySelector(".passKeys"); }
  getRemoveButton(element) { return element.querySelector(".exclusionRemoveButton"); }
}

// ExclusionRulesOnPopupOption is ExclusionRulesOption, extended with some UI tweeks suitable for use in the
// page popup.  This also differs from ExclusionRulesOption in that, on the page popup, there is always a URL
// (@url) associated with the current tab.
class ExclusionRulesOnPopupOption extends ExclusionRulesOption {
  constructor(url, ...args) {
    super(...Array.from(args || []));
    this.url = url;
  }

  addRule() {
    const element = super.addRule(this.generateDefaultPattern());
    this.activatePatternWatcher(element);
    // ExclusionRulesOption.addRule()/super() has focused the pattern.  Here, focus the passKeys instead;
    // because, in the popup, we already have a pattern, so the user is more likely to edit the passKeys.
    this.getPassKeys(element).focus();
    // Return element (for consistency with ExclusionRulesOption.addRule()).
    return element;
  }

  populateElement(rules) {
    let element;
    super.populateElement(rules);
    const elements = this.element.getElementsByClassName("exclusionRuleTemplateInstance");
    for (element of Array.from(elements))
      this.activatePatternWatcher(element);

    let haveMatch = false;
    for (element of Array.from(elements)) {
      const pattern = this.getPattern(element).value.trim();
      if (0 <= this.url.search(bgExclusions.RegexpCache.get(pattern))) {
        haveMatch = true;
        this.getPassKeys(element).focus();
      } else {
        element.style.display = 'none';
      }
    }
    if (!haveMatch)
      return this.addRule();
  }

  // Provide visual feedback (make it red) when a pattern does not match the current tab's URL.
  activatePatternWatcher(element) {
    const patternElement = element.children[0].firstChild;
    patternElement.addEventListener("keyup", () => {
      if (this.url.match(bgExclusions.RegexpCache.get(patternElement.value))) {
        patternElement.title = (patternElement.style.color = "");
      } else {
        patternElement.style.color = "red";
        patternElement.title = "Red text means that the pattern does not\nmatch the current URL.";
      }
    });
  }

  // Generate a default exclusion-rule pattern from a URL.  This is then used to pre-populate the pattern on
  // the page popup.
  generateDefaultPattern() {
    if (/^https?:\/\/./.test(this.url)) {
      // The common use case is to disable Vimium at the domain level.
      // Generate "https?://www.example.com/*" from "http://www.example.com/path/to/page.html".
      // Note: IPV6 host addresses will contain "[" and "]" (which must be escaped).
      const hostname = this.url.split("/",3).slice(1).join("/").replace("[", "\\[").replace("]", "\\]");
      return "https?:/" + hostname + "/*";
    } else if (/^[a-z]{3,}:\/\/./.test(this.url)) {
      // Anything else which seems to be a URL.
      return this.url.split("/",3).join("/") + "/*";
    } else {
      return this.url + "*";
    }
  }
}

const Options = {
  exclusionRules: ExclusionRulesOption,
  filterLinkHints: CheckBoxOption,
  waitForEnterForFilteredHints: CheckBoxOption,
  hideHud: CheckBoxOption,
  keyMappings: TextOption,
  linkHintCharacters: NonEmptyTextOption,
  linkHintNumbers: NonEmptyTextOption,
  newTabUrl: NonEmptyTextOption,
  nextPatterns: NonEmptyTextOption,
  previousPatterns: NonEmptyTextOption,
  regexFindMode: CheckBoxOption,
  ignoreKeyboardLayout: CheckBoxOption,
  scrollStepSize: NumberOption,
  smoothScroll: CheckBoxOption,
  grabBackFocus: CheckBoxOption,
  searchEngines: TextOption,
  searchUrl: NonEmptyTextOption,
  userDefinedLinkHintCss: NonEmptyTextOption
};

const initOptionsPage = function() {
  const onUpdated = function() {
    $("saveOptions").removeAttribute("disabled");
    $("saveOptions").textContent = "Save Changes";
  };

  // Display either "linkHintNumbers" or "linkHintCharacters", depending upon "filterLinkHints".
  const maintainLinkHintsView = function() {
    const hide = el => el.style.display = "none";
    const show = el => el.style.display = "table-row";
    if ($("filterLinkHints").checked) {
      hide($("linkHintCharactersContainer"));
      show($("linkHintNumbersContainer"));
      show($("waitForEnterForFilteredHintsContainer"));
    } else {
      show($("linkHintCharactersContainer"));
      hide($("linkHintNumbersContainer"));
      hide($("waitForEnterForFilteredHintsContainer"));
    }
  };

  const maintainAdvancedOptions = function() {
    if (bgSettings.get("optionsPage_showAdvancedOptions")) {
      $("advancedOptions").style.display = "table-row-group";
      return $("advancedOptionsButton").textContent = "Hide Advanced Options";
    } else {
      $("advancedOptions").style.display = "none";
      return $("advancedOptionsButton").textContent = "Show Advanced Options";
    }
  };
  maintainAdvancedOptions();

  const toggleAdvancedOptions = function(event) {
    bgSettings.set("optionsPage_showAdvancedOptions", !bgSettings.get("optionsPage_showAdvancedOptions"));
    maintainAdvancedOptions();
    $("advancedOptionsButton").blur();
    event.preventDefault();
  };

  const activateHelpDialog = function() {
    HelpDialog.toggle({showAllCommandDetails: true});
  };

  const saveOptions = function() {
    $("linkHintCharacters").value = $("linkHintCharacters").value.toLowerCase();
    Option.saveOptions();
    $("saveOptions").disabled = true;
    $("saveOptions").textContent = "Saved";
  };

  $("saveOptions").addEventListener("click", saveOptions);
  $("advancedOptionsButton").addEventListener("click", toggleAdvancedOptions);
  $("showCommands").addEventListener("click", activateHelpDialog);
  $("filterLinkHints").addEventListener("click", maintainLinkHintsView);

  for (let element of Array.from(document.getElementsByClassName("nonEmptyTextOption"))) {
    element.className = element.className + " example info";
    element.textContent = "Leave empty to reset this option.";
  }

  window.onbeforeunload = function() {
    if (!$("saveOptions").disabled)
      return "You have unsaved changes to options.";
  };

  document.addEventListener("keyup", function(event) {
    if (event.ctrlKey && (event.keyCode === 13)) {
      if (document && document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
        return saveOptions();
      }
    }
  });

  // Populate options. The constructor adds each new object to "Option.all".
  for (let name of Object.keys(Options)) {
    const type = Options[name];
    const option = new type(name, onUpdated);
    option.fetch();
  }

  maintainLinkHintsView();
};

const initPopupPage = function() {
  chrome.tabs.query({ active: true, currentWindow: true }, async function(...args) {
    const [tab] = Array.from(args[0]);
    let exclusions = null;
    document.getElementById("optionsLink").setAttribute("href", chrome.runtime.getURL("vimium/pages/options.html"));

    // In MV3, we can't use chrome.extension.getBackgroundPage()
    // Instead, check if we can communicate with content scripts via messaging
    let tabHasVimium = false;
    
    try {
      // Try to send a message to the tab to check if Vimium is running
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { name: "ping" }, response => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            tabHasVimium = true;
            resolve(response);
          }
        });
        // Timeout after 100ms
        setTimeout(() => reject(new Error("timeout")), 100);
      });
    } catch (e) {
      // Tab doesn't have Vimium running
    }
    
    if (!tabHasVimium) {
      // The browser has disabled Vimium on this page. Place a message explaining this into the popup.
      document.body.innerHTML = `\
<div style="width: 400px; margin: 5px;">
  <p style="margin-bottom: 5px;">
    Vimium is not running on this page.
  </p>
  <p style="margin-bottom: 5px;">
    Your browser does not run web extensions like Vimium on certain pages,
    usually for security reasons.
  </p>
  <p>
    Unless your browser's developers change their policy, then unfortunately it is not possible to make Vimium (or any other
    web extension, for that matter) work on this page.
  </p>
</div>\
`;
      return;
    }

    // Use the tab's URL directly since we can't access urlForTab from service worker
    const url = tab.url;

    const updateState = function() {
      const rule = bgExclusions.getRule(url, exclusions.readValueFromElement());
      $("state").innerHTML = "Vimium will " +
        (rule && rule.passKeys ?
         `exclude <span class='code'>${rule.passKeys}</span>`
         : (rule ? "be disabled" : "be enabled"));
    };

    const onUpdated = function() {
      $("helpText").innerHTML = "Type <strong>Ctrl-Enter</strong> to save and close.";
      $("saveOptions").removeAttribute("disabled");
      $("saveOptions").textContent = "Save Changes";
      if (exclusions)
        return updateState();
    };

    const saveOptions = function() {
      Option.saveOptions();
      $("saveOptions").textContent = "Saved";
      $("saveOptions").disabled = true;
    };

    $("saveOptions").addEventListener("click", saveOptions);

    document.addEventListener("keyup", function(event) {
      if (event.ctrlKey && (event.keyCode === 13)) {
        saveOptions();
        window.close();
      }
    });

    // Populate options. Just one, here.
    exclusions = new ExclusionRulesOnPopupOption(url, "exclusionRules", onUpdated);
    exclusions.fetch();

    updateState();
    document.addEventListener("keyup", updateState);
  });

  // Install version number.
  const manifest = chrome.runtime.getManifest();
  $("versionNumber").textContent = manifest.version;
};


//
// Initialization.
document.addEventListener("DOMContentLoaded", async function() {
  // Wait for background access to be initialized
  await initBackgroundAccess();
  
  DomUtils.injectUserCss(); // Manually inject custom user styles.
  
  // Use fetch instead of XMLHttpRequest for MV3 compatibility
  try {
    const response = await fetch(chrome.runtime.getURL('vimium/pages/exclusions.html'));
    const html = await response.text();
    $("exclusionScrollBox").innerHTML = html;
    switch (location.pathname) {
      case "/vimium/pages/options.html": initOptionsPage(); break;
      case "/vimium/pages/popup.html": initPopupPage(); break;
    }
  } catch (error) {
    console.error("Failed to load exclusions.html:", error);
  }
});

//
// Backup and restore.
if (global.DomUtils) { // global.DomUtils is not defined when running our tests.
  DomUtils.documentReady(async function() {
    // Only initialize backup/restore on the options page (not the popup).
    if (location.pathname !== "/vimium/pages/options.html")
      return;

    // Wait for background access to be initialized
    await initBackgroundAccess();

    let restoreSettingsVersion = null;

  const populateBackupLinkUrl = function() {
    const backup = {settingsVersion: bgSettings.get("settingsVersion")};
    for (let option of Array.from(Option.all))
      backup[option.field] = option.readValueFromElement();

    // In MV3, create the blob directly in this page (no background page access)
    const blob = new Blob([ JSON.stringify(backup, null, 2) + "\n" ]);
    $("backupLink").href = URL.createObjectURL(blob);
  };

  $("backupLink").addEventListener("mousedown", populateBackupLinkUrl, true);

  $("chooseFile").addEventListener("change", function(event) {
    if (document.activeElement)
      document.activeElement.blur();

    const files = event.target.files;
    if (files.length === 1) {
      const file = files[0];
      const reader = new FileReader;
      reader.readAsText(file);
      reader.onload = function(event) {
        let backup;
        try {
          backup = JSON.parse(reader.result);
        } catch (error) {
          alert("Failed to parse Vimium backup.");
          return;
        }

        if ("settingsVersion" in backup)
          restoreSettingsVersion = backup["settingsVersion"];
        for (let option of Array.from(Option.all)) {
          if (option.field in backup) {
            option.populateElement(backup[option.field]);
            option.onUpdated();
          }
        }
      };
    }
  });

  Option.onSave(function() {
    // If we're restoring a backup, then restore the backed up settingsVersion.
    if (restoreSettingsVersion != null) {
      bgSettings.set("settingsVersion", restoreSettingsVersion);
      restoreSettingsVersion = null;
    }
    // Reset the restore-backup input.
    $("chooseFile").value = "";
    // We need to apply migrations in case we are restoring an old backup.
    // In MV3, applyMigrations may not be available from this page, so check first
    if (bgSettings.applyMigrations) {
      bgSettings.applyMigrations();
    }
  });
});
}

// Exported for use by our tests.
global.Options = Options
global.isVimiumOptionsPage = true
