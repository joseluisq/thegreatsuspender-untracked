/* global gsStorage, gsChrome, gsIndexedDb, gsUtils, gsSession, gsMessages, gsTabSuspendManager, gsTabDiscardManager, gsAnalytics, gsTabCheckManager, chrome, XMLHttpRequest */
/*
 * The Great Suspender
 * Copyright (C) 2017 Dean Oemcke
 * Available under GNU GENERAL PUBLIC LICENSE v2
 * http://github.com/deanoemcke/thegreatsuspender
 * ༼ つ ◕_◕ ༽つ
*/
var tgs = (function() {
  // eslint-disable-line no-unused-vars
  'use strict';

  const ICON_SUSPENSION_ACTIVE = {
    '16': 'img/ic_suspendy_16x16.png',
    '32': 'img/ic_suspendy_32x32.png',
  };
  const ICON_SUSPENSION_PAUSED = {
    '16': 'img/ic_suspendy_16x16_grey.png',
    '32': 'img/ic_suspendy_32x32_grey.png',
  };

  // Unsuspended tab props
  const UTP_TIMER_DETAILS = 'timerDetails';
  const UTP_SUSPEND_ON_RELOAD_URL = 'suspendOnReloadUrl';

  // Suspended tab props
  const STP_TEMP_WHITELIST_ON_RELOAD = 'whitelistOnReload';
  const STP_UNSUSPEND_ON_RELOAD_URL = 'unsuspendOnReloadUrl';
  const STP_SUSPEND_REASON = 'suspendReason'; // 1=auto-suspend, 2=manual-suspend, 3=discarded
  const STP_SCROLL_POS = 'scrollPos';
  const STP_SHOW_NAG = 'showNag';

  const focusDelay = 500;
  const noticeCheckInterval = 1000 * 60 * 60 * 12; // every 12 hours
  const sessionMetricsCheckInterval = 1000 * 60 * 15; // every 15 minutes
  const analyticsCheckInterval = 1000 * 60 * 60 * 23.5; // every 23.5 hours

  const _currentFocusedTabIdByWindowId = {};
  const _currentStationaryTabIdByWindowId = {};
  const _unsuspendedTabPropsByTabId = {};
  const _suspendedTabPropsByTabId = {};

  let _currentFocusedWindowId;
  let _currentStationaryWindowId;
  let _sessionSaveTimer;
  let _newTabFocusTimer;
  let _newWindowFocusTimer;
  let _noticeToDisplay;
  let _isCharging = false;
  let _triggerHotkeyUpdate = false;
  let _suspendUnsuspendHotkey;

  function backgroundScriptsReadyAsPromised(retries) {
    retries = retries || 0;
    if (retries > 300) {
      // allow 30 seconds :scream:
      chrome.tabs.create({ url: chrome.extension.getURL('broken.html') });
      return Promise.reject('Failed to initialise background scripts');
    }
    return new Promise(function(resolve) {
      var isReady =
        typeof db !== 'undefined' &&
        typeof gsSession !== 'undefined' &&
        typeof gsStorage !== 'undefined' &&
        typeof gsMessages !== 'undefined' &&
        typeof gsUtils !== 'undefined' &&
        typeof gsAnalytics !== 'undefined';
      resolve(isReady);
    }).then(function(isReady) {
      if (isReady) {
        return Promise.resolve();
      }
      return new Promise(function(resolve) {
        window.setTimeout(resolve, 100);
      }).then(function() {
        retries += 1;
        return backgroundScriptsReadyAsPromised(retries);
      });
    });
  }

  function initAsPromised() {
    return new Promise(async function(resolve) {
      gsUtils.log('background', 'PERFORMING BACKGROUND INIT...');
      addCommandListeners();
      addChromeListeners();
      addMiscListeners();

      //initialise suspended and unsuspended tab props
      const allTabs = await gsChrome.tabsQuery();
      for (const tab of allTabs) {
        if (gsUtils.isSuspendedTab(tab)) {
          initialiseSuspendedTabProps(tab);
        } else if (gsUtils.isNormalTab(tab)) {
          initialiseUnsuspendedTabProps(tab);
        }
      }

      //add context menu items
      if (!chrome.extension.inIncognitoContext) {
        buildContextMenu(false);
        var contextMenus = gsStorage.getOption(gsStorage.ADD_CONTEXT);
        buildContextMenu(contextMenus);
      }

      //initialise currentStationary and currentFocused vars
      const activeTabs = await gsChrome.tabsQuery({ active: true });
      const currentWindow = await gsChrome.windowsGetLastFocused();
      for (let activeTab of activeTabs) {
        _currentStationaryTabIdByWindowId[activeTab.windowId] = activeTab.id;
        _currentFocusedTabIdByWindowId[activeTab.windowId] = activeTab.id;
        if (currentWindow && currentWindow.id === activeTab.windowId) {
          _currentStationaryWindowId = activeTab.windowId;
          _currentFocusedWindowId = activeTab.windowId;
        }
      }
      resolve();
    });
  }

  function startTimers() {
    startNoticeCheckerJob();
    startSessionMetricsJob();
    startAnalyticsUpdateJob();
  }

  function getCurrentlyActiveTab(callback) {
    // wrap this in an anonymous async function so we can use await
    (async function() {
      const currentWindowActiveTabs = await gsChrome.tabsQuery({
        active: true,
        currentWindow: true,
      });
      if (currentWindowActiveTabs.length > 0) {
        callback(currentWindowActiveTabs[0]);
        return;
      }
      if (!_currentStationaryWindowId) {
        callback(null);
        return;
      }

      const currentStationaryWindowActiveTabs = await gsChrome.tabsQuery({
        active: true,
        windowId: _currentStationaryWindowId,
      });
      if (currentStationaryWindowActiveTabs.length > 0) {
        callback(currentStationaryWindowActiveTabs[0]);
        return;
      }
      const currentStationaryTabId =
        _currentStationaryTabIdByWindowId[_currentStationaryWindowId];
      if (!currentStationaryTabId) {
        callback(null);
        return;
      }

      const currentStationaryTab = await gsChrome.tabsGet(
        currentStationaryTabId
      );
      if (currentStationaryTab !== null) {
        callback(currentStationaryTab);
        return;
      }
      callback(null);
    })();
  }

  // NOTE: Stationary here means has had focus for more than focusDelay ms
  // So it may not necessarily have the tab.active flag set to true
  function isCurrentStationaryTab(tab) {
    if (tab.windowId !== _currentStationaryWindowId) {
      return false;
    }
    var lastStationaryTabIdForWindow =
      _currentStationaryTabIdByWindowId[tab.windowId];
    if (lastStationaryTabIdForWindow) {
      return tab.id === lastStationaryTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function isCurrentFocusedTab(tab) {
    if (tab.windowId !== _currentFocusedWindowId) {
      return false;
    }
    var currentFocusedTabIdForWindow =
      _currentFocusedTabIdByWindowId[tab.windowId];
    if (currentFocusedTabIdForWindow) {
      return tab.id === currentFocusedTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function isCurrentActiveTab(tab) {
    const activeTabIdForWindow = _currentFocusedTabIdByWindowId[tab.windowId];
    if (activeTabIdForWindow) {
      return tab.id === activeTabIdForWindow;
    } else {
      // fallback on active flag
      return tab.active;
    }
  }

  function whitelistHighlightedTab(includePath) {
    includePath = includePath || false;
    getCurrentlyActiveTab(function(activeTab) {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          let url = gsUtils.getRootUrl(
            gsUtils.getSuspendedUrl(activeTab.url),
            includePath
          );
          gsUtils.saveToWhitelist(url);
          unsuspendTab(activeTab);
        } else {
          let url = gsUtils.getRootUrl(activeTab.url, includePath);
          gsUtils.saveToWhitelist(url);
          calculateTabStatus(activeTab, null, function(status) {
            setIconStatus(status, activeTab.id);
          });
        }
      }
    });
  }

  function unwhitelistHighlightedTab(callback) {
    getCurrentlyActiveTab(function(activeTab) {
      if (activeTab) {
        gsUtils.removeFromWhitelist(activeTab.url);
        calculateTabStatus(activeTab, null, function(status) {
          setIconStatus(status, activeTab.id);
          if (callback) callback(status);
        });
      } else {
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
      }
    });
  }

  function toggleTempWhitelistStateOfHighlightedTab(callback) {
    getCurrentlyActiveTab(function(activeTab) {
      if (!activeTab) {
        if (callback) callback(status);
        return;
      }
      if (gsUtils.isSuspendedTab(activeTab)) {
        gsMessages.sendTemporaryWhitelistToSuspendedTab(activeTab.id); //async. unhandled error
        if (callback) callback(gsUtils.STATUS_UNKNOWN);
        return;
      }
      calculateTabStatus(activeTab, null, function(status) {
        if (
          status === gsUtils.STATUS_ACTIVE ||
          status === gsUtils.STATUS_NORMAL
        ) {
          gsMessages.sendTemporaryWhitelistToContentScript(
            activeTab.id,
            function(error, response) {
              if (error) {
                gsUtils.warning(
                  activeTab.id,
                  'Failed to sendTemporaryWhitelistToContentScript',
                  error
                );
              }
              var contentScriptStatus =
                response && response.status ? response.status : null;
              calculateTabStatus(activeTab, contentScriptStatus, function(
                newStatus
              ) {
                setIconStatus(newStatus, activeTab.id);
                //This is a hotfix for issue #723
                if (
                  newStatus === 'tempWhitelist' &&
                  activeTab.autoDiscardable
                ) {
                  chrome.tabs.update(activeTab.id, {
                    autoDiscardable: false,
                  });
                }
                if (callback) callback(newStatus);
              });
            }
          );
        } else if (
          status === gsUtils.STATUS_TEMPWHITELIST ||
          status === gsUtils.STATUS_FORMINPUT
        ) {
          gsMessages.sendUndoTemporaryWhitelistToContentScript(
            activeTab.id,
            function(error, response) {
              if (error) {
                gsUtils.warning(
                  activeTab.id,
                  'Failed to sendUndoTemporaryWhitelistToContentScript',
                  error
                );
              }
              var contentScriptStatus =
                response && response.status ? response.status : null;
              calculateTabStatus(activeTab, contentScriptStatus, function(
                newStatus
              ) {
                setIconStatus(newStatus, activeTab.id);
                //This is a hotfix for issue #723
                if (
                  newStatus !== 'tempWhitelist' &&
                  !activeTab.autoDiscardable
                ) {
                  chrome.tabs.update(activeTab.id, {
                    //async
                    autoDiscardable: true,
                  });
                }
                if (callback) callback(newStatus);
              });
            }
          );
        } else {
          if (callback) callback(status);
        }
      });
    });
  }

  function openLinkInSuspendedTab(parentTab, linkedUrl) {
    //imitate chromes 'open link in new tab' behaviour in how it selects the correct index
    chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }, tabs => {
      var newTabIndex = parentTab.index + 1;
      var nextTab = tabs[newTabIndex];
      while (nextTab && nextTab.openerTabId === parentTab.id) {
        newTabIndex++;
        nextTab = tabs[newTabIndex];
      }
      var newTabProperties = {
        url: linkedUrl,
        index: newTabIndex,
        openerTabId: parentTab.id,
        active: false,
      };
      chrome.tabs.create(newTabProperties, tab => {
        setUnsuspendedTabPropForTabId(
          tab.id,
          UTP_SUSPEND_ON_RELOAD_URL,
          tab.url
        );
      });
    });
  }

  function toggleSuspendedStateOfHighlightedTab() {
    getCurrentlyActiveTab(activeTab => {
      if (activeTab) {
        if (gsUtils.isSuspendedTab(activeTab)) {
          unsuspendTab(activeTab);
        } else {
          gsTabSuspendManager.queueTabForSuspension(activeTab, 1);
        }
      }
    });
  }

  function suspendHighlightedTab() {
    getCurrentlyActiveTab(activeTab => {
      if (activeTab) {
        gsTabSuspendManager.queueTabForSuspension(activeTab, 1);
      }
    });
  }

  function unsuspendHighlightedTab() {
    getCurrentlyActiveTab(activeTab => {
      if (activeTab && gsUtils.isSuspendedTab(activeTab)) {
        unsuspendTab(activeTab);
      }
    });
  }

  function suspendAllTabs(force) {
    const forceLevel = force ? 1 : 2;
    getCurrentlyActiveTab(activeTab => {
      if (!activeTab) {
        gsUtils.warning(
          'background',
          'Could not determine currently active window.'
        );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, curWindow => {
        for (const tab of curWindow.tabs) {
          if (!tab.active) {
            gsTabSuspendManager.queueTabForSuspension(tab, forceLevel);
          }
        }
      });
    });
  }

  function suspendAllTabsInAllWindows(force) {
    const forceLevel = force ? 1 : 2;
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        gsTabSuspendManager.queueTabForSuspension(tab, forceLevel);
      }
    });
  }

  function unsuspendAllTabs() {
    getCurrentlyActiveTab(function(activeTab) {
      if (!activeTab) {
        gsUtils.warning(
          'background',
          'Could not determine currently active window.'
        );
        return;
      }
      chrome.windows.get(activeTab.windowId, { populate: true }, curWindow => {
        for (const tab of curWindow) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            unsuspendTab(tab);
          } else if (gsUtils.isNormalTab(tab) && !tab.active) {
            resetAutoSuspendTimerForTab(tab);
          }
        }
      });
    });
  }

  function unsuspendAllTabsInAllWindows() {
    chrome.windows.getLastFocused({}, currentWindow => {
      chrome.tabs.query({}, tabs => {
        // Because of the way that unsuspending steals window focus, we defer the suspending of tabs in the
        // current window until last
        var deferredTabs = [];
        for (const tab of tabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            if (tab.windowId === currentWindow.id) {
              deferredTabs.push(tab);
            } else {
              unsuspendTab(tab);
            }
          } else if (gsUtils.isNormalTab(tab)) {
            resetAutoSuspendTimerForTab(tab);
          }
        }
        for (const tab of deferredTabs) {
          unsuspendTab(tab);
        }
      });
    });
  }

  function suspendSelectedTabs() {
    chrome.tabs.query(
      { highlighted: true, lastFocusedWindow: true },
      selectedTabs => {
        for (const tab of selectedTabs) {
          gsTabSuspendManager.queueTabForSuspension(tab, 1);
        }
      }
    );
  }

  function unsuspendSelectedTabs() {
    chrome.tabs.query(
      { highlighted: true, lastFocusedWindow: true },
      selectedTabs => {
        for (const tab of selectedTabs) {
          gsTabSuspendManager.unqueueTabForSuspension(tab);
          if (gsUtils.isSuspendedTab(tab)) {
            unsuspendTab(tab);
          }
        }
      }
    );
  }

  function resuspendSuspendedTab(tab) {
    gsMessages.sendDisableUnsuspendOnReloadToSuspendedTab(tab.id, function(
      error
    ) {
      if (error) {
        gsUtils.warning(
          tab.id,
          'Failed to sendDisableUnsuspendOnReloadToSuspendedTab',
          error
        );
      } else {
        chrome.tabs.reload(tab.id);
      }
    });
  }

  function queueSessionTimer() {
    clearTimeout(_sessionSaveTimer);
    _sessionSaveTimer = setTimeout(function() {
      gsUtils.log('background', 'updating current session');
      gsSession.updateCurrentSession(); //async
    }, 1000);
  }

  function resetAutoSuspendTimerForTab(tab) {
    clearAutoSuspendTimerForTab(tab);

    const suspendTime = gsStorage.getOption(gsStorage.SUSPEND_TIME);
    const timeToSuspend = suspendTime * (1000 * 60);
    if (
      gsUtils.isProtectedActiveTab(tab) ||
      isNaN(suspendTime) ||
      suspendTime <= 0
    ) {
      return;
    }

    const timerDetails = {};
    timerDetails.tabId = tab.id;
    timerDetails.suspendDateTime = new Date(
      new Date().getTime() + timeToSuspend
    );
    timerDetails.timer = setTimeout(async () => {
      const updatedTabId = timerDetails.tabId; // This may get updated via updateTabIdReferences
      const updatedTab = await gsChrome.tabsGet(updatedTabId);
      if (!updatedTab) {
        gsUtils.warning(updatedTabId, 'Couldnt find tab. Aborting suspension');
        return;
      }
      gsTabSuspendManager.queueTabForSuspension(updatedTab, 3);
    }, timeToSuspend);

    setUnsuspendedTabPropForTabId(tab.id, UTP_TIMER_DETAILS, timerDetails);
  }

  function resetAutoSuspendTimerForAllTabs() {
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) {
        if (gsUtils.isSuspendedTab(tab) || gsUtils.isSpecialTab(tab)) {
          return;
        }
        resetAutoSuspendTimerForTab(tab);
      }
    });
  }

  function clearAutoSuspendTimerForTab(tab) {
    const timerDetails = getUnsuspendedTabPropForTabId(
      tab.id,
      UTP_TIMER_DETAILS
    );
    if (!timerDetails) {
      return;
    }
    clearTimeout(timerDetails.timer);
    setUnsuspendedTabPropForTabId(tab.id, UTP_TIMER_DETAILS, null);
  }

  function getUnsuspendedTabPropForTabId(tabId, prop) {
    return _unsuspendedTabPropsByTabId[tabId]
      ? _unsuspendedTabPropsByTabId[tabId][prop]
      : undefined;
  }
  function setUnsuspendedTabPropForTabId(tabId, prop, value) {
    gsUtils.log(tabId, `Setting unsuspended tab prop: ${prop}:`, value);
    var tabProps = _unsuspendedTabPropsByTabId[tabId] || {};
    tabProps[prop] = value;
    _unsuspendedTabPropsByTabId[tabId] = tabProps;
  }
  function clearUnsuspendedTabPropsForTabId(tabId) {
    delete _unsuspendedTabPropsByTabId[tabId];
  }

  function getSuspendedTabPropForTabId(tabId, prop) {
    return _suspendedTabPropsByTabId[tabId]
      ? _suspendedTabPropsByTabId[tabId][prop]
      : undefined;
  }
  function setSuspendedTabPropForTabId(tabId, prop, value) {
    gsUtils.log(tabId, `Setting suspended tab prop: ${prop}:`, value);
    var tabProps = _suspendedTabPropsByTabId[tabId] || {};
    tabProps[prop] = value;
    _suspendedTabPropsByTabId[tabId] = tabProps;
  }
  function clearSuspendedTabPropsForTabId(tabId) {
    delete _suspendedTabPropsByTabId[tabId];
  }

  function unsuspendTab(tab) {
    if (!gsUtils.isSuspendedTab(tab)) return;
    gsUtils.log(tab.id, 'Unsuspending tab.');

    // If the suspended tab is discarded then reload the tab directly.
    // This will happen if the 'discard suspended tabs' option is turned on and the tab
    // is being unsuspended remotely.
    // Reloading directly causes a history item for the suspended tab to be made in the tab history.
    if (gsUtils.isDiscardedTab(tab)) {
      chrome.tabs.update(tab.id, { url: gsUtils.getSuspendedUrl(tab.url) });
      return;
    }

    gsMessages.sendUnsuspendRequestToSuspendedTab(tab.id, function(error) {
      if (error) {
        gsUtils.warning(
          tab.id,
          'Failed to sendUnsuspendRequestToSuspendedTab',
          error
        );
        let url = gsUtils.getSuspendedUrl(tab.url);
        if (url) {
          gsUtils.log(tab.id, 'Will reload directly.');
          chrome.tabs.update(tab.id, { url: url });
        }
      }
    });
  }

  function getSuspendUnsuspendHotkey(callback) {
    if (_suspendUnsuspendHotkey) {
      callback(_suspendUnsuspendHotkey);
      return;
    }
    resetSuspendUnsuspendHotkey(function(hotkeyChanged) {
      callback(_suspendUnsuspendHotkey);
    });
  }

  function resetSuspendUnsuspendHotkey(callback) {
    gsUtils.buildSuspendUnsuspendHotkey(function(hotkey) {
      var hotkeyChanged = hotkey !== _suspendUnsuspendHotkey;
      _suspendUnsuspendHotkey = hotkey;
      callback(hotkeyChanged);
    });
  }

  function updateSuspendUnsuspendHotkey() {
    resetSuspendUnsuspendHotkey(function(hotkeyChanged) {
      if (hotkeyChanged) {
        getSuspendUnsuspendHotkey(function(hotkey) {
          gsMessages.sendRefreshToAllSuspendedTabs({
            //async
            command: hotkey,
          });
        });
      }
    });
  }

  function checkForTriggerUrls(tab, url) {
    // test for special case of a successful donation
    if (url === 'https://greatsuspender.github.io/thanks.html') {
      gsStorage.setOption(gsStorage.NO_NAG, true);
      gsAnalytics.reportEvent('Donations', 'HidePopupAuto', true);
      chrome.tabs.update(tab.id, {
        url: chrome.extension.getURL('thanks.html'),
      });

      // test for a save of keyboard shortcuts (chrome://extensions/shortcuts)
    } else if (url === 'chrome://extensions/shortcuts') {
      _triggerHotkeyUpdate = true;
    }
  }

  function handleUnsuspendedTabStateChanged(tab, changeInfo) {
    if (
      !changeInfo.hasOwnProperty('status') &&
      !changeInfo.hasOwnProperty('audible') &&
      !changeInfo.hasOwnProperty('pinned') &&
      !changeInfo.hasOwnProperty('discarded')
    ) {
      return;
    }
    gsUtils.log(
      tab.id,
      'unsuspended tab state changed. changeInfo: ',
      changeInfo
    );

    //check if tab has just been discarded
    if (changeInfo.hasOwnProperty('discarded') && changeInfo.discarded) {
      const existingSuspendReason = getSuspendedTabPropForTabId(
        tab.id,
        STP_SUSPEND_REASON
      );
      if (existingSuspendReason && existingSuspendReason === 3) {
        // For some reason the discarded changeInfo gets called twice (chrome bug?)
        // As a workaround we use the suspend reason to determine if we've already
        // handled this discard
        //TODO: Report chrome bug
        return;
      }
      gsUtils.log(
        tab.id,
        'Unsuspended tab has been discarded. Url: ' + tab.url
      );
      gsTabDiscardManager.handleDiscardedUnsuspendedTab(tab); //async. unhandled promise.

      // When a tab is discarded the tab id changes. We need up-to-date ids
      // in the current session otherwise crash recovery will not work
      queueSessionTimer();
      return;
    }

    let hasTabStatusChanged = false;

    //check for change in tabs audible status
    if (changeInfo.hasOwnProperty('audible')) {
      //reset tab timer if tab has just finished playing audio
      if (!changeInfo.audible && gsStorage.getOption(gsStorage.IGNORE_AUDIO)) {
        resetAutoSuspendTimerForTab(tab);
      }
      hasTabStatusChanged = true;
    }
    if (changeInfo.hasOwnProperty('pinned')) {
      //reset tab timer if tab has become unpinned
      if (!changeInfo.pinned && gsStorage.getOption(gsStorage.IGNORE_PINNED)) {
        resetAutoSuspendTimerForTab(tab);
      }
      hasTabStatusChanged = true;
    }

    //if page has finished loading
    if (
      changeInfo.hasOwnProperty('status') &&
      changeInfo.status === 'complete'
    ) {
      //check for suspend on reload
      const suspendOnReloadUrl = getUnsuspendedTabPropForTabId(
        tab.id,
        UTP_SUSPEND_ON_RELOAD_URL
      );
      if (suspendOnReloadUrl) {
        setUnsuspendedTabPropForTabId(tab.id, UTP_SUSPEND_ON_RELOAD_URL, null);
        if (suspendOnReloadUrl === tab.url) {
          gsUtils.log(tab.id, 'Suspend on reload flag set. Will suspend tab.');
          gsTabSuspendManager.queueTabForSuspension(tab, 1);
          return;
        }
      }

      hasTabStatusChanged = true;

      //init loaded tab
      initialiseUnsuspendedTabProps(tab);
      initialiseUnsuspendedTabScriptAsPromised(tab)
        .catch(error => {
          gsUtils.warning(
            tab.id,
            'Failed to send init to content script. Tab may not behave as expected.'
          );
        })
        .then(() => {
          // could use returned tab status here below
          clearSuspendedTabPropsForTabId(tab.id);
        });
    }

    //if tab is currently visible then update popup icon
    if (hasTabStatusChanged && isCurrentFocusedTab(tab)) {
      calculateTabStatus(tab, null, function(status) {
        setIconStatus(status, tab.id);
      });
    }
  }

  function initialiseUnsuspendedTabProps(tab) {
    resetAutoSuspendTimerForTab(tab);
  }

  function initialiseUnsuspendedTabScriptAsPromised(tab) {
    return new Promise((resolve, reject) => {
      const ignoreForms = gsStorage.getOption(gsStorage.IGNORE_FORMS);
      const isTempWhitelist = getSuspendedTabPropForTabId(
        tab.id,
        STP_TEMP_WHITELIST_ON_RELOAD
      );
      const scrollPos =
        getSuspendedTabPropForTabId(tab.id, STP_SCROLL_POS) || null;
      gsMessages.sendInitTabToContentScript(
        tab.id,
        ignoreForms,
        isTempWhitelist,
        scrollPos,
        (error, response) => {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  function handleSuspendedTabStateChanged(tab, changeInfo) {
    if (!changeInfo.hasOwnProperty('status')) {
      return;
    }

    gsUtils.log(
      tab.id,
      'suspended tab status changed. changeInfo: ',
      changeInfo
    );

    if (changeInfo.status === 'loading') {
      //if a suspended tab is being reloaded, we may want to actually unsuspend it instead
      //if the STP_UNSUSPEND_ON_RELOAD_URL flag is matches the current url, then unsuspend.
      let unsuspendOnReloadUrl = getSuspendedTabPropForTabId(
        tab.id,
        STP_UNSUSPEND_ON_RELOAD_URL
      );
      if (unsuspendOnReloadUrl) {
        setSuspendedTabPropForTabId(tab.id, STP_UNSUSPEND_ON_RELOAD_URL, null);
        if (unsuspendOnReloadUrl === tab.url) {
          gsUtils.log(
            tab.id,
            'Unsuspend on reload flag set. Will unsuspend tab.'
          );
          unsuspendTab(tab);
        }
      }
      return;
    }

    if (changeInfo.status === 'complete') {
      gsTabSuspendManager.unqueueTabForSuspension(tab); //safety precaution

      initialiseSuspendedTabProps(tab);
      initialiseSuspendedTabScriptAsPromised(tab)
        .then(response => {
          if (isCurrentFocusedTab(tab)) {
            setIconStatus(gsUtils.STATUS_SUSPENDED, tab.id);
          } else {
            gsTabCheckManager.queueTabCheck(tab);
          }
          clearUnsuspendedTabPropsForTabId(tab.id);
        })
        .catch(error => {
          gsUtils.warning(tab.id, error);
        });
    }
  }

  function initialiseSuspendedTabProps(tab) {
    const options = gsStorage.getSettings();
    if (!options[gsStorage.NO_NAG]) {
      let showNag = getSuspendedTabPropForTabId(tab.id, STP_SHOW_NAG);
      if (showNag === undefined || showNag === null) {
        //show dude and donate link (randomly 1 of 20 times)
        showNag = Math.random() > 0.95;
        setSuspendedTabPropForTabId(tab.id, STP_SHOW_NAG, showNag);
      }
    }
    // Set scrollPosition tab flag
    const scrollPosition = gsUtils.getSuspendedScrollPosition(tab.url);
    setSuspendedTabPropForTabId(tab.id, STP_SCROLL_POS, scrollPosition);
  }

  function initialiseSuspendedTabScriptAsPromised(tab) {
    return new Promise(async (resolve, reject) => {
      const suspendedUrl = tab.url;
      const originalUrl = gsUtils.getSuspendedUrl(suspendedUrl);
      const whitelisted = gsUtils.checkWhiteList(originalUrl);
      const tabProperties = await gsIndexedDb.fetchTabInfo(originalUrl);

      const favIconUrl =
        tabProperties && tabProperties.favIconUrl
          ? tabProperties.favIconUrl
          : gsUtils.generateFaviconFromUrl(originalUrl);
      const faviconMeta = await gsTabSuspendManager.getFaviconMetaData(
        favIconUrl
      );

      let title =
        tabProperties && tabProperties.title
          ? tabProperties.title
          : gsUtils.getSuspendedTitle(suspendedUrl);
      if (title.indexOf('<') >= 0) {
        // Encode any raw html tags that might be used in the title
        title = gsUtils.htmlEncode(title);
      }

      const preview = await gsIndexedDb.fetchPreviewImage(originalUrl);
      let previewUri = null;
      if (
        preview &&
        preview.img &&
        preview.img !== null &&
        preview.img !== 'data:,' &&
        preview.img.length > 10000
      ) {
        previewUri = preview.img;
      }
      const showNag = getSuspendedTabPropForTabId(tab.id, STP_SHOW_NAG);

      const options = gsStorage.getSettings();
      getSuspendUnsuspendHotkey(function(hotkey) {
        var payload = {
          tabId: tab.id,
          tabActive: tab.active,
          requestUnsuspendOnReload: true,
          url: originalUrl,
          faviconMeta: faviconMeta,
          title: title,
          whitelisted: whitelisted,
          theme: options[gsStorage.THEME],
          showNag: showNag,
          previewMode: options[gsStorage.SCREEN_CAPTURE],
          previewUri: previewUri,
          command: hotkey,
        };
        const suspendReason = getSuspendedTabPropForTabId(
          tab.id,
          STP_SUSPEND_REASON
        );
        if (suspendReason === 3) {
          payload.reason = chrome.i18n.getMessage('js_suspended_low_memory');
        }
        gsMessages.sendInitSuspendedTab(tab.id, payload, function(
          error,
          response
        ) {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        });
      });
    });
  }

  function updateTabIdReferences(newTabId, oldTabId) {
    gsUtils.log(oldTabId, 'update tabId references to ' + newTabId);
    for (const windowId of Object.keys(_currentFocusedTabIdByWindowId)) {
      if (_currentFocusedTabIdByWindowId[windowId] === oldTabId) {
        _currentFocusedTabIdByWindowId[windowId] = newTabId;
      }
    }
    for (const windowId of Object.keys(_currentStationaryTabIdByWindowId)) {
      if (_currentStationaryTabIdByWindowId[windowId] === oldTabId) {
        _currentStationaryTabIdByWindowId[windowId] = newTabId;
      }
    }
    if (_suspendedTabPropsByTabId[oldTabId]) {
      _suspendedTabPropsByTabId[newTabId] = _suspendedTabPropsByTabId[oldTabId];
      delete _suspendedTabPropsByTabId[oldTabId];
    }
    if (_unsuspendedTabPropsByTabId[oldTabId]) {
      _unsuspendedTabPropsByTabId[newTabId] =
        _unsuspendedTabPropsByTabId[oldTabId];
      delete _unsuspendedTabPropsByTabId[oldTabId];
    }
    const timerDetails = getUnsuspendedTabPropForTabId(
      newTabId,
      UTP_TIMER_DETAILS
    );
    if (timerDetails) {
      timerDetails.tabId = newTabId;
    }
  }

  function removeTabIdReferences(tabId) {
    gsUtils.log(tabId, 'removing tabId references to ' + tabId);
    for (const windowId of Object.keys(_currentFocusedTabIdByWindowId)) {
      if (_currentFocusedTabIdByWindowId[windowId] === tabId) {
        _currentFocusedTabIdByWindowId[windowId] = null;
      }
    }
    for (const windowId of Object.keys(_currentStationaryTabIdByWindowId)) {
      if (_currentStationaryTabIdByWindowId[windowId] === tabId) {
        _currentStationaryTabIdByWindowId[windowId] = null;
      }
    }
    clearSuspendedTabPropsForTabId(tabId);
    clearUnsuspendedTabPropsForTabId(tabId);
  }

  function handleWindowFocusChanged(windowId) {
    if (windowId < 0) {
      return;
    }
    gsUtils.log(windowId, 'window changed');
    _currentFocusedWindowId = windowId;

    // Get the active tab in the newly focused window
    chrome.tabs.query({ active: true }, function(tabs) {
      if (!tabs || !tabs.length) {
        return;
      }
      var focusedTab;
      for (var tab of tabs) {
        if (tab.windowId === windowId) {
          focusedTab = tab;
        }
      }
      if (!focusedTab) {
        gsUtils.warning(
          'background',
          `Couldnt find active tab with windowId: ${windowId}. Window may have been closed.`
        );
        return;
      }

      //update icon
      calculateTabStatus(focusedTab, null, function(status) {
        setIconStatus(status, focusedTab.id);
      });

      //pause for a bit before assuming we're on a new window as some users
      //will key through intermediate windows to get to the one they want.
      queueNewWindowFocusTimer(focusedTab.id, windowId, focusedTab);
    });
  }

  async function handleTabFocusChanged(tabId, windowId) {
    gsUtils.log(tabId, 'tab gained focus');

    const previouslyFocusedTabId = _currentFocusedTabIdByWindowId[windowId];
    _currentFocusedTabIdByWindowId[windowId] = tabId;

    // If the tab focused before this was the keyboard shortcuts page, then update hotkeys on suspended pages
    if (_triggerHotkeyUpdate) {
      updateSuspendUnsuspendHotkey();
      _triggerHotkeyUpdate = false;
    }

    const focusedTab = await gsChrome.tabsGet(tabId);

    gsTabDiscardManager.unqueueTabForDiscard(focusedTab);

    //update icon
    calculateTabStatus(focusedTab, null, function(status) {
      setIconStatus(status, focusedTab.id);
    });

    //pause for a bit before assuming we're on a new tab as some users
    //will key through intermediate tabs to get to the one they want.
    queueNewTabFocusTimer(tabId, windowId, focusedTab);

    // test for a save of keyboard shortcuts (chrome://extensions/shortcuts)
    if (focusedTab.url === 'chrome://extensions/shortcuts') {
      _triggerHotkeyUpdate = true;
    }

    //queue job to discard previously focused tab
    let discardAfterSuspend = gsStorage.getOption(
      gsStorage.DISCARD_AFTER_SUSPEND
    );
    if (!discardAfterSuspend) {
      return;
    }

    const previouslyFocusedTab = previouslyFocusedTabId
      ? await gsChrome.tabsGet(previouslyFocusedTabId)
      : null;
    if (
      !previouslyFocusedTab ||
      !gsUtils.isSuspendedTab(previouslyFocusedTab, true)
    ) {
      return;
    }

    await gsUtils.setTimeout(2000); // Allow time for tabCheck to initiate

    const tabCheckDetails = gsTabCheckManager.getQueuedTabCheckDetails(
      previouslyFocusedTab
    );
    if (tabCheckDetails) {
      gsUtils.log(
        previouslyFocusedTab.id,
        'Aborting tab discard queueing as tab in currently queued for tabCheck.'
      );
      return;
    }

    gsUtils.log(previouslyFocusedTabId, 'Discarding previously focused tab');
    gsTabDiscardManager.queueTabForDiscard(previouslyFocusedTab);
  }

  function queueNewWindowFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newWindowFocusTimer);
    _newWindowFocusTimer = setTimeout(function() {
      var previousStationaryWindowId = _currentStationaryWindowId;
      _currentStationaryWindowId = windowId;
      var previousStationaryTabId =
        _currentStationaryTabIdByWindowId[previousStationaryWindowId];
      handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function queueNewTabFocusTimer(tabId, windowId, focusedTab) {
    clearTimeout(_newTabFocusTimer);
    _newTabFocusTimer = setTimeout(function() {
      var previousStationaryTabId = _currentStationaryTabIdByWindowId[windowId];
      _currentStationaryTabIdByWindowId[windowId] = focusedTab.id;
      handleNewStationaryTabFocus(tabId, previousStationaryTabId, focusedTab);
    }, focusDelay);
  }

  function handleNewStationaryTabFocus(
    focusedTabId,
    previousStationaryTabId,
    focusedTab
  ) {
    gsUtils.log(focusedTabId, 'new tab focus handled');
    //remove request to suspend this tab id
    if (
      getUnsuspendedTabPropForTabId(focusedTabId, UTP_SUSPEND_ON_RELOAD_URL)
    ) {
      setUnsuspendedTabPropForTabId(
        focusedTabId,
        UTP_SUSPEND_ON_RELOAD_URL,
        null
      );
    }

    if (gsUtils.isSuspendedTab(focusedTab)) {
      var autoUnsuspend = gsStorage.getOption(gsStorage.UNSUSPEND_ON_FOCUS);
      if (autoUnsuspend) {
        if (navigator.onLine) {
          unsuspendTab(focusedTab);
        } else {
          gsMessages.sendNoConnectivityMessageToSuspendedTab(focusedTab.id); //async. unhandled error
        }
      }
    } else if (gsUtils.isNormalTab(focusedTab)) {
      //clear timer on newly focused tab
      if (focusedTab.status === 'complete') {
        clearAutoSuspendTimerForTab(focusedTab);
      }

      //if focusedTab is already in the queue for suspension then remove it.
      //although sometimes it seems that this is a 'fake' tab focus resulting
      //from the popup menu disappearing. in these cases the previousStationaryTabId
      //should match the current tabId (fix for issue #735)
      if (previousStationaryTabId && previousStationaryTabId !== focusedTabId) {
        gsTabSuspendManager.unqueueTabForSuspension(focusedTab);
      }
    } else if (focusedTab.url === chrome.extension.getURL('options.html')) {
      gsMessages.sendReloadOptionsToOptionsTab(focusedTab.id); //async. unhandled error
    }

    //Perhaps this check could apply to the whole function?
    if (previousStationaryTabId && previousStationaryTabId !== focusedTabId) {
      chrome.tabs.get(previousStationaryTabId, function(previousStationaryTab) {
        if (chrome.runtime.lastError) {
          //Tab has probably been removed
          return;
        }

        //Reset timer on tab that lost focus.
        //NOTE: This may be due to a change in window focus in which case the tab may still have .active = true
        if (
          previousStationaryTab &&
          gsUtils.isNormalTab(previousStationaryTab) &&
          !gsUtils.isProtectedActiveTab(previousStationaryTab)
        ) {
          resetAutoSuspendTimerForTab(previousStationaryTab);
        }
      });
    }
  }

  function promptForFilePermissions() {
    getCurrentlyActiveTab(activeTab => {
      chrome.tabs.create({
        url: chrome.extension.getURL('permissions.html'),
        index: activeTab.index + 1,
      });
    });
  }

  function checkForNotices() {
    gsUtils.log('background', 'Checking for notices..');
    var xhr = new XMLHttpRequest();
    var lastShownNoticeVersion = gsStorage.fetchNoticeVersion();

    xhr.open('GET', 'https://greatsuspender.github.io/notice.json', true);
    xhr.timeout = 4000;
    xhr.setRequestHeader('Cache-Control', 'no-cache');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4 && xhr.responseText) {
        var resp;
        try {
          resp = JSON.parse(xhr.responseText);
        } catch (e) {
          gsUtils.error(
            'background',
            'Failed to parse notice response',
            xhr.responseText
          );
          return;
        }

        if (!resp || !resp.active || !resp.text) {
          gsUtils.log('background', 'No new notice found');
          return;
        }

        //only show notice if it is intended for this extension version
        var noticeTargetExtensionVersion = String(resp.target);
        if (
          noticeTargetExtensionVersion !== chrome.runtime.getManifest().version
        ) {
          gsUtils.log(
            'background',
            `Notice target extension version: ${noticeTargetExtensionVersion} 
            does not match actual extension version: ${
              chrome.runtime.getManifest().version
            }`
          );
          return;
        }

        //only show notice if it has not already been shown
        var noticeVersion = String(resp.version);
        if (noticeVersion <= lastShownNoticeVersion) {
          gsUtils.log(
            'background',
            `Notice version: ${noticeVersion} is not greater than last shown notice version: ${lastShownNoticeVersion}`
          );
          return;
        }

        //show notice - set global notice field (so that it can be trigger to show later)
        _noticeToDisplay = resp;
        gsAnalytics.reportEvent(
          'Notice',
          'Prep',
          resp.target + ':' + resp.version
        );
      }
    };
    xhr.send();
  }

  function requestNotice() {
    return _noticeToDisplay;
  }
  function clearNotice() {
    _noticeToDisplay = undefined;
  }

  function isCharging() {
    return _isCharging;
  }

  function getDebugInfo(tabId, callback) {
    const timerDetails = getUnsuspendedTabPropForTabId(
      tabId,
      UTP_TIMER_DETAILS
    );
    const info = {
      windowId: '',
      tabId: '',
      status: gsUtils.STATUS_UNKNOWN,
      timerUp: timerDetails ? timerDetails.suspendDateTime : '-',
    };

    chrome.tabs.get(tabId, function(tab) {
      if (chrome.runtime.lastError) {
        gsUtils.error(tabId, chrome.runtime.lastError);
        callback(info);
        return;
      }

      info.windowId = tab.windowId;
      info.tabId = tab.id;
      if (gsUtils.isNormalTab(tab) && !gsUtils.isDiscardedTab(tab)) {
        gsMessages.sendRequestInfoToContentScript(tab.id, function(
          error,
          tabInfo
        ) {
          if (error) {
            gsUtils.warning(tab.id, 'Failed to getDebugInfo', error);
          }
          if (tabInfo) {
            calculateTabStatus(tab, tabInfo.status, function(status) {
              info.status = status;
              callback(info);
            });
          } else {
            callback(info);
          }
        });
      } else {
        calculateTabStatus(tab, null, function(status) {
          info.status = status;
          callback(info);
        });
      }
    });
  }

  function getContentScriptStatus(tabId, knownContentScriptStatus) {
    return new Promise(function(resolve) {
      if (knownContentScriptStatus) {
        resolve(knownContentScriptStatus);
      } else {
        gsMessages.sendRequestInfoToContentScript(tabId, function(
          error,
          tabInfo
        ) {
          if (error) {
            gsUtils.warning(tabId, 'Failed to getContentScriptStatus', error);
          }
          if (tabInfo) {
            resolve(tabInfo.status);
          } else {
            resolve(null);
          }
        });
      }
    });
  }

  //possible suspension states are:
  //loading: tab object has a state of 'loading'
  //normal: a tab that will be suspended
  //blockedFile: a file:// tab that can theoretically be suspended but is being blocked by the user's settings
  //special: a tab that cannot be suspended
  //suspended: a tab that is suspended
  //discarded: a tab that has been discarded
  //never: suspension timer set to 'never suspend'
  //formInput: a tab that has a partially completed form (and IGNORE_FORMS is true)
  //audible: a tab that is playing audio (and IGNORE_AUDIO is true)
  //active: a tab that is active (and IGNORE_ACTIVE_TABS is true)
  //tempWhitelist: a tab that has been manually paused
  //pinned: a pinned tab (and IGNORE_PINNED is true)
  //whitelisted: a tab that has been whitelisted
  //charging: computer currently charging (and IGNORE_WHEN_CHARGING is true)
  //noConnectivity: internet currently offline (and IGNORE_WHEN_OFFLINE is true)
  //unknown: an error detecting tab status
  function calculateTabStatus(tab, knownContentScriptStatus, callback) {
    //check for loading
    if (tab.status === 'loading') {
      callback(gsUtils.STATUS_LOADING);
      return;
    }
    //check if it is a blockedFile tab (this needs to have precedence over isSpecialTab)
    if (gsUtils.isBlockedFileTab(tab)) {
      callback(gsUtils.STATUS_BLOCKED_FILE);
      return;
    }
    //check if it is a special tab
    if (gsUtils.isSpecialTab(tab)) {
      callback(gsUtils.STATUS_SPECIAL);
      return;
    }
    //check if tab has been discarded
    if (gsUtils.isDiscardedTab(tab)) {
      callback(gsUtils.STATUS_DISCARDED);
      return;
    }
    //check if it has already been suspended
    if (gsUtils.isSuspendedTab(tab)) {
      callback(gsUtils.STATUS_SUSPENDED);
      return;
    }
    //check whitelist
    if (gsUtils.checkWhiteList(tab.url)) {
      callback(gsUtils.STATUS_WHITELISTED);
      return;
    }
    //check never suspend
    //should come after whitelist check as it causes popup to show the whitelisting option
    if (gsStorage.getOption(gsStorage.SUSPEND_TIME) === '0') {
      callback(gsUtils.STATUS_NEVER);
      return;
    }
    getContentScriptStatus(tab.id, knownContentScriptStatus).then(function(
      contentScriptStatus
    ) {
      if (
        contentScriptStatus &&
        contentScriptStatus !== gsUtils.STATUS_NORMAL
      ) {
        callback(contentScriptStatus);
        return;
      }
      //check running on battery
      if (gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING) && _isCharging) {
        callback(gsUtils.STATUS_CHARGING);
        return;
      }
      //check internet connectivity
      if (
        gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE) &&
        !navigator.onLine
      ) {
        callback(gsUtils.STATUS_NOCONNECTIVITY);
        return;
      }
      //check pinned tab
      if (gsUtils.isProtectedPinnedTab(tab)) {
        callback(gsUtils.STATUS_PINNED);
        return;
      }
      //check audible tab
      if (gsUtils.isProtectedAudibleTab(tab)) {
        callback(gsUtils.STATUS_AUDIBLE);
        return;
      }
      //check active
      if (gsUtils.isProtectedActiveTab(tab)) {
        callback(gsUtils.STATUS_ACTIVE);
        return;
      }
      if (contentScriptStatus) {
        callback(contentScriptStatus); // should be 'normal'
        return;
      }
      callback(gsUtils.STATUS_UNKNOWN);
    });
  }

  function getActiveTabStatus(callback) {
    getCurrentlyActiveTab(function(tab) {
      if (!tab) {
        callback(gsUtils.STATUS_UNKNOWN);
        return;
      }
      calculateTabStatus(tab, null, function(status) {
        callback(status);
      });
    });
  }

  //change the icon to either active or inactive
  function setIconStatus(status, tabId) {
    // gsUtils.log(tabId, 'Setting icon status: ' + status);
    var icon = ![gsUtils.STATUS_NORMAL, gsUtils.STATUS_ACTIVE].includes(status)
      ? ICON_SUSPENSION_PAUSED
      : ICON_SUSPENSION_ACTIVE;
    chrome.browserAction.setIcon({ path: icon, tabId: tabId }, function() {
      if (chrome.runtime.lastError) {
        gsUtils.warning(
          tabId,
          chrome.runtime.lastError,
          `Failed to set icon for tab. Tab may have been closed.`
        );
      }
    });
  }

  function setIconStatusForActiveTab() {
    getCurrentlyActiveTab(function(tab) {
      if (!tab) {
        return;
      }
      calculateTabStatus(tab, null, function(status) {
        setIconStatus(status, tab.id);
      });
    });
  }

  //HANDLERS FOR RIGHT-CLICK CONTEXT MENU
  //NOTE: In canary, the 'separator' elements do not currently display
  //TODO: Report chrome bug

  function buildContextMenu(showContextMenu) {
    var allContexts = ['page', 'frame', 'editable', 'image', 'video', 'audio']; //'selection',

    if (!showContextMenu) {
      chrome.contextMenus.removeAll();
    } else {
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_open_link_in_suspended_tab'),
        contexts: ['link'],
        onclick: (info, tab) => {
          openLinkInSuspendedTab(tab, info.linkUrl);
        },
      });

      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_toggle_suspend_state'),
        contexts: allContexts,
        onclick: () => toggleSuspendedStateOfHighlightedTab(),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_toggle_pause_suspension'),
        contexts: allContexts,
        onclick: () => toggleTempWhitelistStateOfHighlightedTab(),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_never_suspend_page'),
        contexts: allContexts,
        onclick: () => whitelistHighlightedTab(true),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_never_suspend_domain'),
        contexts: allContexts,
        onclick: () => whitelistHighlightedTab(false),
      });

      chrome.contextMenus.create({
        contexts: allContexts,
        type: 'separator',
      });

      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_suspend_selected_tabs'),
        contexts: allContexts,
        onclick: () => suspendSelectedTabs(),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_unsuspend_selected_tabs'),
        contexts: allContexts,
        onclick: () => unsuspendSelectedTabs(),
      });

      chrome.contextMenus.create({
        contexts: allContexts,
        type: 'separator',
      });

      chrome.contextMenus.create({
        title: chrome.i18n.getMessage(
          'js_context_soft_suspend_other_tabs_in_window'
        ),
        contexts: allContexts,
        onclick: () => suspendAllTabs(false),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage(
          'js_context_force_suspend_other_tabs_in_window'
        ),
        contexts: allContexts,
        onclick: () => suspendAllTabs(true),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage(
          'js_context_unsuspend_all_tabs_in_window'
        ),
        contexts: allContexts,
        onclick: () => unsuspendAllTabs(),
      });

      chrome.contextMenus.create({
        contexts: allContexts,
        type: 'separator',
      });

      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_soft_suspend_all_tabs'),
        contexts: allContexts,
        onclick: () => suspendAllTabsInAllWindows(false),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_force_suspend_all_tabs'),
        contexts: allContexts,
        onclick: () => suspendAllTabsInAllWindows(true),
      });
      chrome.contextMenus.create({
        title: chrome.i18n.getMessage('js_context_unsuspend_all_tabs'),
        contexts: allContexts,
        onclick: () => unsuspendAllTabsInAllWindows(),
      });
    }
  }

  //HANDLERS FOR KEYBOARD SHORTCUTS

  function addCommandListeners() {
    chrome.commands.onCommand.addListener(function(command) {
      if (command === '1-suspend-tab') {
        toggleSuspendedStateOfHighlightedTab();
      } else if (command === '2-toggle-temp-whitelist-tab') {
        toggleTempWhitelistStateOfHighlightedTab();
      } else if (command === '2a-suspend-selected-tabs') {
        suspendSelectedTabs();
      } else if (command === '2b-unsuspend-selected-tabs') {
        unsuspendSelectedTabs();
      } else if (command === '3-suspend-active-window') {
        suspendAllTabs(false);
      } else if (command === '3b-force-suspend-active-window') {
        suspendAllTabs(true);
      } else if (command === '4-unsuspend-active-window') {
        unsuspendAllTabs();
      } else if (command === '4b-soft-suspend-all-windows') {
        suspendAllTabsInAllWindows(false);
      } else if (command === '5-suspend-all-windows') {
        suspendAllTabsInAllWindows(true);
      } else if (command === '6-unsuspend-all-windows') {
        unsuspendAllTabsInAllWindows();
      }
    });
  }

  //HANDLERS FOR CONTENT SCRIPT MESSAGE REQUESTS

  function contentScriptMessageRequestListener(request, sender, sendResponse) {
    gsUtils.log(
      sender.tab.id,
      'contentScriptMessageRequestListener',
      request.action
    );

    switch (request.action) {
      case 'reportTabState':
        var contentScriptStatus =
          request && request.status ? request.status : null;
        if (
          contentScriptStatus === 'formInput' ||
          contentScriptStatus === 'tempWhitelist'
        ) {
          chrome.tabs.update(sender.tab.id, { autoDiscardable: false });
        } else if (!sender.tab.autoDiscardable) {
          chrome.tabs.update(sender.tab.id, { autoDiscardable: true });
        }
        // If tab is currently visible then update popup icon
        if (sender.tab && isCurrentFocusedTab(sender.tab)) {
          calculateTabStatus(sender.tab, contentScriptStatus, function(status) {
            setIconStatus(status, sender.tab.id);
          });
        }
        break;

      case 'savePreviewData':
        if (request.previewUrl) {
          gsIndexedDb
            .addPreviewImage(sender.tab.url, request.previewUrl)
            .then(() =>
              gsTabSuspendManager.resumeQueuedTabSuspension(sender.tab)
            ); //async. unhandled promise.
        } else {
          gsUtils.warning(
            'savePreviewData reported an error: ' + request.errorMsg
          );
          gsTabSuspendManager.resumeQueuedTabSuspension(sender.tab); //async. unhandled promise.
        }
        break;
    }
    sendResponse();
    return false;
  }

  function addChromeListeners() {
    //attach listener to runtime
    chrome.runtime.onMessage.addListener(contentScriptMessageRequestListener);
    //attach listener to runtime for external messages, to allow
    //interoperability with other extensions in the manner of an API
    chrome.runtime.onMessageExternal.addListener(
      contentScriptMessageRequestListener
    );

    chrome.windows.onFocusChanged.addListener(function(windowId) {
      handleWindowFocusChanged(windowId);
    });
    chrome.tabs.onActivated.addListener(function(activeInfo) {
      handleTabFocusChanged(activeInfo.tabId, activeInfo.windowId); // async. unhandled promise
    });
    chrome.tabs.onReplaced.addListener(function(addedTabId, removedTabId) {
      updateTabIdReferences(addedTabId, removedTabId);
    });
    chrome.tabs.onCreated.addListener(async function(tab) {
      gsUtils.log(tab.id, 'tab created. tabUrl: ' + tab.url);
      queueSessionTimer();
      if (gsUtils.isSuspendedTab(tab, true)) {
        gsTabCheckManager.queueTabCheck(tab);
      }
    });
    chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) {
      gsUtils.log(tabId, 'tab removed.');
      queueSessionTimer();
      removeTabIdReferences(tabId);
    });
    chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
      if (!changeInfo) return;

      // if url has changed
      if (changeInfo.url) {
        gsUtils.log(tabId, 'tab url changed. changeInfo: ', changeInfo);
        checkForTriggerUrls(tab, changeInfo.url);
        queueSessionTimer();
      }

      if (gsUtils.isSuspendedTab(tab, true)) {
        handleSuspendedTabStateChanged(tab, changeInfo);
      } else if (gsUtils.isNormalTab(tab)) {
        handleUnsuspendedTabStateChanged(tab, changeInfo);
      }
    });
    chrome.windows.onCreated.addListener(function(window) {
      gsUtils.log(window.id, 'window created.');
      queueSessionTimer();

      var noticeToDisplay = requestNotice();
      if (noticeToDisplay) {
        chrome.tabs.create({ url: chrome.extension.getURL('notice.html') });
        gsAnalytics.reportEvent(
          'Notice',
          'Display',
          noticeToDisplay.target + ':' + noticeToDisplay.version
        );
      }
    });
    chrome.windows.onRemoved.addListener(function(windowId) {
      gsUtils.log(windowId, 'window removed.');
      queueSessionTimer();
    });

    //tidy up history items as they are created
    //NOTE: This only affects tab history, and has no effect on chrome://history
    //It is also impossible to remove a the first tab history entry for a tab
    //Refer to: https://github.com/deanoemcke/thegreatsuspender/issues/717
    chrome.history.onVisited.addListener(function(historyItem) {
      if (gsUtils.isSuspendedUrl(historyItem.url, true)) {
        //remove suspended tab history item
        chrome.history.deleteUrl({ url: historyItem.url });
      }
    });
  }

  function addMiscListeners() {
    //add listener for battery state changes
    if (navigator.getBattery) {
      navigator.getBattery().then(function(battery) {
        _isCharging = battery.charging;

        battery.onchargingchange = function() {
          _isCharging = battery.charging;
          gsUtils.log('background', `_isCharging: ${_isCharging}`);
          setIconStatusForActiveTab();
          //restart timer on all normal tabs
          //NOTE: some tabs may have been prevented from suspending when computer was charging
          if (
            !_isCharging &&
            gsStorage.getOption(gsStorage.IGNORE_WHEN_CHARGING)
          ) {
            resetAutoSuspendTimerForAllTabs();
          }
        };
      });
    }

    //add listeners for online/offline state changes
    window.addEventListener('online', function() {
      gsUtils.log('background', 'Internet is online.');
      //restart timer on all normal tabs
      //NOTE: some tabs may have been prevented from suspending when internet was offline
      if (gsStorage.getOption(gsStorage.IGNORE_WHEN_OFFLINE)) {
        resetAutoSuspendTimerForAllTabs();
      }
      setIconStatusForActiveTab();
    });
    window.addEventListener('offline', function() {
      gsUtils.log('background', 'Internet is offline.');
      setIconStatusForActiveTab();
    });
  }

  function startNoticeCheckerJob() {
    checkForNotices();
    window.setInterval(checkForNotices, noticeCheckInterval);
  }

  function startSessionMetricsJob() {
    gsSession.updateSessionMetrics(true);
    window.setInterval(
      gsSession.updateSessionMetrics,
      sessionMetricsCheckInterval
    );
  }

  function startAnalyticsUpdateJob() {
    window.setInterval(() => {
      gsAnalytics.performPingReport();
      const reset = true;
      gsSession.updateSessionMetrics(reset);
    }, analyticsCheckInterval);
  }

  return {
    UTP_TIMER_DETAILS,
    UTP_SUSPEND_ON_RELOAD_URL,
    getUnsuspendedTabPropForTabId,
    setUnsuspendedTabPropForTabId,

    STP_TEMP_WHITELIST_ON_RELOAD,
    STP_UNSUSPEND_ON_RELOAD_URL,
    STP_SUSPEND_REASON,
    getSuspendedTabPropForTabId,
    setSuspendedTabPropForTabId,

    backgroundScriptsReadyAsPromised,
    initAsPromised,
    startTimers,
    requestNotice,
    clearNotice,
    buildContextMenu,
    resuspendSuspendedTab,
    getActiveTabStatus,
    getDebugInfo,
    calculateTabStatus,
    isCharging,
    isCurrentStationaryTab,
    isCurrentFocusedTab,
    isCurrentActiveTab,
    resetAutoSuspendTimerForTab,
    resetAutoSuspendTimerForAllTabs,

    initialiseUnsuspendedTabProps,
    initialiseUnsuspendedTabScriptAsPromised,
    initialiseSuspendedTabProps,
    initialiseSuspendedTabScriptAsPromised,
    unsuspendTab,
    unsuspendHighlightedTab,
    unwhitelistHighlightedTab,
    toggleTempWhitelistStateOfHighlightedTab,
    suspendHighlightedTab,
    suspendAllTabs,
    unsuspendAllTabs,
    suspendSelectedTabs,
    unsuspendSelectedTabs,
    whitelistHighlightedTab,
    unsuspendAllTabsInAllWindows,
    promptForFilePermissions,
  };
})();

tgs
  .backgroundScriptsReadyAsPromised()
  .then(() => gsAnalytics.initAsPromised())
  .then(() => gsStorage.initSettingsAsPromised())
  .then(() => gsTabSuspendManager.initAsPromised())
  .then(() => gsTabCheckManager.initAsPromised())
  .then(() => gsTabDiscardManager.initAsPromised())
  .then(() => gsSession.initAsPromised())
  .then(() => gsSession.runStartupChecks()) // performs crash check (and maybe recovery) and tab responsiveness checks
  .catch(error => {
    error = error || 'Unknown error occurred during background initialisation';
    gsUtils.error('background', error);
  })
  .then(() => tgs.initAsPromised()) // adds handle(Un)SuspendedTabChanged listeners!
  .then(() => {
    return new Promise(resolve => {
      gsAnalytics.performStartupReport();
      gsAnalytics.performVersionReport();
      tgs.startTimers();
      resolve();
    });
  });
