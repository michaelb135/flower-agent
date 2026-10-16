'use strict';

// Keep this callback separate from Tidy: it loads no account data, application
// state or third-party resources. Microsoft's bridge validates the response
// shape, clears authentication parameters from the URL, then passes the response
// to the waiting MSAL popup interaction on this origin. MSAL verifies OAuth state
// and redeems the authorization code using its original PKCE verifier.
(async function () {
  const status = document.getElementById('calendar-auth-status');
  try {
    await window.msalRedirectBridge.broadcastResponseToMainFrame();
    status.textContent = 'Calendar sign-in returned to Tidy. You can close this window.';
  } catch (_) {
    // Never display or log provider errors: their contents may include private
    // authentication parameters. The official bridge clears malformed responses.
    // Clear defensively as well if the local SDK failed to load or initialize.
    try {
      window.history.replaceState(null, '', window.location.origin + window.location.pathname);
    } catch (_) {}
    status.textContent = 'Calendar sign-in could not finish. Close this window, return to Tidy and try connecting again.';
  }
}());
