/* KrishiMonitor frontend. Set API_BASE_URL only to a public API origin; keep all secrets on the server. */
const CONFIG = {
  API_BASE_URL: String(window.KRISHI_API_BASE_URL || "").replace(/\/+$/, ""),
  ENDPOINTS: { health: "/api/health", analyze: "/api/crop/analyze", weatherCurrent: "/api/weather/current", weatherForecast: "/api/weather/forecast", weatherHistory: "/api/weather/history", weatherGeocode: "/api/weather/geocode", riskMap: "/api/risk-map" },
  MAX_IMAGE_BYTES: 10 * 1024 * 1024,
  MIN_IMAGE_DIMENSION: 256,
  MAX_IMAGE_DIMENSION: 4096,
  MAX_PROMPT_CHARS: 2000,
  ACCEPTED_TYPES: ["image/jpeg", "image/png", "image/webp"]
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { credentials: "include", ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`The service did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}
let serviceHealth = null;
let databaseRecordsEnabled = false;
let persistentDataLoaded = false;
let serverCropRecords = [];
let serverReports = [];
let serverAlerts = [];
let csrfToken = null;
function apiUrl(path) { return `${CONFIG.API_BASE_URL}${path}`; }
async function apiRequest(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrfToken && !['GET','HEAD'].includes(String(options.method || 'GET').toUpperCase()) ? { 'X-CSRF-Token': csrfToken } : {}), ...(options.headers || {}) };
  const response = await fetchWithTimeout(apiUrl(path), { ...options, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Service returned ${response.status}.`);
  return data;
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const accountOverlay = $('#account-overlay');
const accountForm = $('#account-form');
const accountFields = $('#account-fields');
const accountMessage = $('#account-message');
const accountLinks = $('#account-links');
const accountTitle = $('#account-title');
const accountIntro = $('#account-intro');
const accountProfile = $('#account-profile');
let accountMode = 'login';
let currentUser = null;
function accountStatus(text = '', kind = '') { accountMessage.textContent = text; accountMessage.className = `account-message ${kind}`.trim(); }
function showAccount(mode = 'login') {
  accountMode = mode; accountOverlay.hidden = false; accountOverlay.dataset.mode = mode;
  accountForm.hidden = mode === 'profile'; accountProfile.hidden = mode !== 'profile';
  const templates = {
    login: ['Sign in to your farm.', 'Access your private crops and reports.', '<label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>'],
    signup: ['Create your account.', 'Verify your email to keep your farm records private.', '<label>Full name<input name="fullName" autocomplete="name" required minlength="2" maxlength="100"></label><label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><label class="account-check"><input name="acceptedTerms" type="checkbox" required><span>I agree to the <a href="terms.html" target="_blank" rel="noopener">Terms</a> and <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>'],
    forgot: ['Reset your password.', 'WeÃ¢â‚¬â„¢ll email a time limited reset link if an account matches.', '<label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254"></label>'],
    reset: ['Choose a new password.', 'Use at least 12 characters. Your reset link works once.', '<label>New password<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><label>Confirm new password<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></label>'],
    verify: ['Verify your email.', 'Complete email verification to activate your account.', '<label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254"></label>'],
    profile: ['Your account.', 'Signed in with your verified email.', '']
  };
  const [title, intro, fields] = templates[mode] || templates.login;
  accountTitle.textContent = title; accountIntro.textContent = intro; accountFields.innerHTML = fields; accountStatus();
  accountFields.querySelectorAll('input[type="password"]').forEach(input => {
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'account-password-toggle'; toggle.dataset.showPassword = ''; toggle.textContent = 'Show password'; input.insertAdjacentElement('afterend', toggle);
  });
  const links = {
    login: '<button type="button" data-account-mode="forgot">Forgot password?</button><button type="button" data-account-mode="signup">Create account</button>',
    signup: '<button type="button" data-account-mode="login">Already have an account? Sign in</button>',
    forgot: '<button type="button" data-account-mode="login">Back to sign in</button>',
    reset: '<button type="button" data-account-mode="login">Back to sign in</button>',
    verify: '<button type="button" data-account-mode="login">Back to sign in</button>',
    profile: '<button type="button" id="account-logout">Sign out</button>'
  };
  accountLinks.innerHTML = links[mode] || links.login;
  $('#account-submit').textContent = ({ login: 'Sign in', signup: 'Create account', forgot: 'Send reset link', reset: 'Update password', verify: 'Resend verification email' })[mode] || 'Continue';
  if (mode === 'profile' && currentUser) accountProfile.innerHTML = `<strong>${escapeHtml(currentUser.fullName)}</strong><p>${escapeHtml(currentUser.email)} Ã‚Â· ${currentUser.emailVerified ? 'Verified' : 'Not verified'}</p>`;
  accountOverlay.querySelector('input')?.focus();
}
function closeAccount() { accountOverlay.hidden = true; }
document.addEventListener('click', event => {
  const modeButton = event.target.closest('[data-account-mode]'); if (modeButton) showAccount(modeButton.dataset.accountMode);
  if (event.target.closest('#account-logout')) void logoutAccount();
  const reveal = event.target.closest('[data-show-password]'); if (reveal) { const input = reveal.previousElementSibling; input.type = input.type === 'password' ? 'text' : 'password'; reveal.textContent = input.type === 'password' ? 'Show password' : 'Hide password'; }
});
$('#account-close').addEventListener('click', closeAccount);
accountOverlay.addEventListener('click', event => { if (event.target === accountOverlay) closeAccount(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !accountOverlay.hidden) closeAccount(); });
async function authPost(action, payload = {}) {
  const response = await fetchWithTimeout(apiUrl(`/api/auth/${action}`), { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`); return data;
}
function setSignedIn(user, token) {
  currentUser = user; csrfToken = token || null;
  $$('[data-login]').forEach(loginLink => { loginLink.textContent = user ? user.fullName : 'Log in'; loginLink.href = user ? '#profile' : '#login'; });
  if (!user) { databaseRecordsEnabled = false; persistentDataLoaded = false; serverCropRecords = []; serverReports = []; serverAlerts = []; renderCrops(); renderRequests(); renderServerAlerts(); }
  if (user) { persistentDataLoaded = false; void refreshBackendHealth(); }
}
async function logoutAccount() {
  try { await authPost('logout'); } catch (error) { accountStatus(error.message, 'error'); return; }
  setSignedIn(null, null); serverCropRecords = []; serverReports = []; serverAlerts = []; closeAccount();
}
accountForm.addEventListener('submit', async event => {
  event.preventDefault(); if (!accountForm.reportValidity()) return;
  const button = $('#account-submit'); button.disabled = true; accountStatus('Please waitÃ¢â‚¬Â¦');
  const values = Object.fromEntries(new FormData(accountForm)); values.acceptedTerms = accountForm.elements.acceptedTerms?.checked === true;
  try {
    if (accountMode === 'login') { const data = await authPost('login', values); setSignedIn(data.user, data.csrfToken); accountStatus('Signed in successfully.', 'success'); closeAccount(); location.hash = 'dashboard'; }
    else if (accountMode === 'signup') { const data = await authPost('signup', values); accountStatus(data.message, 'success'); accountForm.reset(); }
    else if (accountMode === 'forgot') { const data = await authPost('forgot-password', values); accountStatus(data.message, 'success'); }
    else if (accountMode === 'verify') { const data = await authPost('resend-verification', values); accountStatus(data.message, 'success'); }
    else if (accountMode === 'reset') { const data = await authPost('reset-password', { ...values, token: new URLSearchParams(location.hash.slice(1)).get('reset') }); accountStatus(data.message, 'success'); history.replaceState(null, '', '#login'); showAccount('login'); accountStatus(data.message, 'success'); }
  } catch (error) { accountStatus(error.message, 'error'); if (accountMode === 'login' && /Verify your email/.test(error.message)) accountLinks.innerHTML = '<button type="button" data-account-mode="verify">Resend verification email</button><button type="button" data-account-mode="signup">Create account</button>'; }
  finally { button.disabled = false; }
});
const menuToggle = $(".menu-toggle");
const navLinks = $(".nav-links");
menuToggle.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  navLinks.classList.toggle("open", open);
});
navLinks.addEventListener("click", event => {
  if (event.target.closest("a")) {
    navLinks.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open navigation menu");
  }
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 760 && navLinks.classList.contains("open")) {
    navLinks.classList.remove("open");
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open navigation menu");
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && navLinks.classList.contains("open")) {
    navLinks.classList.remove("open"); menuToggle.setAttribute("aria-expanded", "false"); menuToggle.focus();
  }
});

// Elevate the sticky header after scrolling without changing its dimensions.
const siteHeader = $(".site-header");
let headerFrame = 0;
window.addEventListener("scroll", () => {
  if (headerFrame) return;
  headerFrame = requestAnimationFrame(() => {
    siteHeader.classList.toggle("is-scrolled", window.scrollY > 12);
    headerFrame = 0;
  });
}, { passive: true });

$("#year").textContent = new Date().getFullYear();
$$("[data-login]").forEach(link => link.addEventListener("click", event => {
  event.preventDefault();
  showAccount(currentUser ? 'profile' : 'login');
}));
async function restoreAccountSession() {
  try {
    const response = await fetchWithTimeout(apiUrl('/api/auth/me'), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json(); if (data.user) setSignedIn(data.user, data.csrfToken);
  } catch {}
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const verifyToken = hashParams.get('verify'), resetToken = hashParams.get('reset');
  if (verifyToken) {
    history.replaceState(null, '', '#login'); showAccount('login');
    try { const data = await authPost('verify-email', { token: verifyToken }); setSignedIn(data.user, data.csrfToken); accountStatus('Email verified. You are signed in.', 'success'); }
    catch (error) { showAccount('login'); accountStatus(error.message, 'error'); }
  } else if (resetToken) { showAccount('reset'); }
}
void restoreAccountSession();

const fileInput = $("#crop-image");
const dropZone = $("#drop-zone");
const previewWrap = $("#preview-wrap");
const previewImage = $("#image-preview");
const message = $("#upload-message");
const analyzeButton = $("#analyze-button");
const result = $("#analysis-result");
let selectedFile = null;
let previewUrl = null;
let cameraStream = null;
let cameraRequestId = 0;

function setUploadMessage(text, type = "") { message.textContent = text; message.className = `form-message ${type}`.trim(); }
function setCameraMessage(text) { $("#camera-message").textContent = text; }
function stopCamera() {
  cameraRequestId += 1;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
  $("#camera-preview").srcObject = null;
  $("#camera-panel").hidden = true;
}
async function openCamera() {
  if (cameraStream) return;
  const requestId = ++cameraRequestId;
  const panel = $("#camera-panel");
  panel.hidden = false;
  $("#use-camera-fallback").hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraMessage("Live camera access is not supported here. Use the device camera option or choose a gallery photo.");
    $("#use-camera-fallback").hidden = false;
    return;
  }
  if (!window.isSecureContext) {
    setCameraMessage("Camera access needs a secure page (HTTPS or localhost). You can still choose a photo from your device.");
    $("#use-camera-fallback").hidden = false;
    return;
  }
  setCameraMessage("Allow camera access when your browser asks. We request the rear camera when available.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    if (requestId !== cameraRequestId) { stream.getTracks().forEach(track => track.stop()); return; }
    cameraStream = stream;
    const video = $("#camera-preview");
    video.srcObject = cameraStream;
    await video.play();
    setCameraMessage("Frame the affected area in good light, then capture.");
  } catch (error) {
    if (requestId !== cameraRequestId) return;
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;
    $("#camera-preview").srcObject = null;
    const advice = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
      ? "Camera permission was not granted. Allow it in browser settings, or choose a gallery photo."
      : error.name === "NotFoundError" ? "No camera was found. Choose a photo from your gallery."
        : "Could not start the camera. Choose a gallery photo or use the device camera option.";
    setCameraMessage(advice);
    $("#use-camera-fallback").hidden = false;
  }
}
function captureCameraPhoto() {
  const video = $("#camera-preview");
  if (!cameraStream || !video.videoWidth || !video.videoHeight) { setCameraMessage("Camera is not ready yet. Wait for the preview or choose a gallery photo."); return; }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || typeof canvas.toBlob !== "function") throw new Error("Photo capture is not supported by this browser.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) { setCameraMessage("Could not capture this photo. Please try again or choose a gallery photo."); return; }
      stopCamera();
      acceptFile(new File([blob], `crop-${Date.now()}.jpg`, { type: "image/jpeg", lastModified: Date.now() }));
    }, "image/jpeg", 0.9);
  } catch (error) { setCameraMessage(`${error.message} Choose a gallery photo instead.`); }
}
previewImage.addEventListener("load", () => {
  if (!selectedFile) return;
  if (previewImage.naturalWidth < 512 || previewImage.naturalHeight < 512) {
    setUploadMessage("This image is small. A clear, well-lit photo at 512 Ãƒâ€” 512 px or larger is easier to review.", "warning");
  }
});
previewImage.addEventListener("error", () => {
  if (!selectedFile) return;
  setUploadMessage("This browser cannot preview the selected format. The file remains selected for a configured analysis service.");
});
function clearSelection() {
  stopCamera();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; selectedFile = null; fileInput.value = "";
  previewWrap.hidden = true; previewImage.removeAttribute("src"); analyzeButton.disabled = true;
  $("#retake-photo").hidden = true;
  result.innerHTML = '<span class="result-leaf">\u2736</span><span>Your analysis status will appear here.</span>';
  setUploadMessage("Choose an image to prepare an analysis request.");
}
function detectActualImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}
async function acceptFile(file) {
  if (!file) return;
  if (!file.size) { setUploadMessage("This image could not be processed. Please upload another photo.", "error"); return; }
  if (file.size > CONFIG.MAX_IMAGE_BYTES) { setUploadMessage(`Image must be ${CONFIG.MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.`, "error"); return; }
  let detectedType = "";
  let candidateUrl = "";
  let dimensions;
  try {
    detectedType = detectActualImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    if (!CONFIG.ACCEPTED_TYPES.includes(detectedType)) { setUploadMessage("Please upload a JPG, PNG, or WEBP image.", "error"); return; }
    candidateUrl = URL.createObjectURL(file);
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
    } else {
      const image = new Image(); image.src = candidateUrl;
      await image.decode(); dimensions = { width: image.naturalWidth, height: image.naturalHeight };
    }
  } catch {
    if (candidateUrl) URL.revokeObjectURL(candidateUrl);
    setUploadMessage("This image could not be processed. Please upload another photo.", "error"); return;
  }
  if (!dimensions?.width || !dimensions?.height || dimensions.width < CONFIG.MIN_IMAGE_DIMENSION || dimensions.height < CONFIG.MIN_IMAGE_DIMENSION || dimensions.width > CONFIG.MAX_IMAGE_DIMENSION || dimensions.height > CONFIG.MAX_IMAGE_DIMENSION) {
    if (candidateUrl) URL.revokeObjectURL(candidateUrl);
    setUploadMessage(`Image dimensions must be between ${CONFIG.MIN_IMAGE_DIMENSION} \u00d7 ${CONFIG.MIN_IMAGE_DIMENSION} and ${CONFIG.MAX_IMAGE_DIMENSION} \u00d7 ${CONFIG.MAX_IMAGE_DIMENSION} pixels.`, "error"); return;
  }
  stopCamera();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  selectedFile = file; previewUrl = candidateUrl; previewImage.src = previewUrl;
  $("#file-name").textContent = `${file.name} \u00b7 ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  previewWrap.hidden = false; analyzeButton.disabled = false; $("#retake-photo").hidden = false;
  setUploadMessage("Image ready. Review it, then choose Analyze Crop.");
  result.textContent = "No diagnosis has been requested yet.";
}
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []); fileInput.value = "";
  if (files.length > 1) { setUploadMessage("Please upload one crop image at a time.", "error"); return; }
  if (files[0]) acceptFile(files[0]);
});
$("#camera-fallback-input").addEventListener("change", event => {
  const files = Array.from(event.target.files || []); event.target.value = "";
  if (files.length > 1) { setUploadMessage("Please upload one crop image at a time.", "error"); return; }
  if (files[0]) acceptFile(files[0]);
});
$("#start-camera").addEventListener("click", openCamera);
$("#choose-gallery").addEventListener("click", () => fileInput.click());
$("#retake-photo").addEventListener("click", () => { clearSelection(); openCamera(); });
$("#capture-photo").addEventListener("click", captureCameraPhoto);
$("#close-camera").addEventListener("click", stopCamera);
$("#use-camera-fallback").addEventListener("click", () => $("#camera-fallback-input").click());
window.addEventListener("pagehide", stopCamera);
$("#remove-image").addEventListener("click", clearSelection);
dropZone.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); fileInput.click(); } });
for (const type of ["dragenter", "dragover"]) dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add("dragover"); });
for (const type of ["dragleave", "drop"]) dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove("dragover"); });
dropZone.addEventListener("drop", event => acceptFile(event.dataTransfer.files[0]));

$("#crop-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (analyzeButton.disabled) return;
  if (!$("#analysis-crop").value) { setUploadMessage("Select a crop before analysis.", "error"); $("#analysis-crop").focus(); return; }
  if (!selectedFile) { setUploadMessage("Take a photo or choose an image before analysis.", "error"); return; }
  if (!$("#analysis-consent").checked) { setUploadMessage("Please agree before sending this photo to the configured analysis service.", "error"); $("#analysis-consent").focus(); return; }
  if (!serviceHealth) await refreshBackendHealth();
  if (!serviceHealth) { setUploadMessage("Backend is unavailable. Your photo was not uploaded. Please retry when the service is online.", "error"); return; }
  if (!serviceHealth.services?.ai?.configured) { setUploadMessage("AI analysis is not configured on the backend. Your photo was not uploaded.", "error"); result.textContent = "Set GEMINI_API_KEY on the backend to enable crop analysis."; return; }
  analyzeButton.disabled = true; analyzeButton.textContent = "Analyzing\u2026";
  previewWrap.classList.add("is-scanning");
  result.textContent = "Sending your photo to the configured AI service for analysisÃ¢â‚¬Â¦";
  try {
    const body = new FormData();
    body.append("image", selectedFile);
    body.append("crop", $("#analysis-crop").value);
    body.append("affectedPart", $("#affected-part").value);
    body.append("growthStage", $("#analysis-stage").value);
    body.append("location", $("#analysis-location").value.trim());
    body.append("photoConsent", "true");
    body.append("language", $("#analysis-language").value || "hi");
    body.append("saveReport", $("#save-analysis-report").checked ? "true" : "false");
    const response = await fetchWithTimeout(apiUrl(CONFIG.ENDPOINTS.analyze), { method: "POST", body, headers: { Accept: "application/json", ...(csrfToken && currentUser && $('#save-analysis-report').checked ? { 'X-CSRF-Token': csrfToken } : {}) } }, 125000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Analysis service returned ${response.status}`);
    renderDiagnosis(data);
    setUploadMessage("Analysis received from the configured backend.");
  } catch (error) {
    result.textContent = `Analysis could not be completed: ${error.message || "The analysis service did not return a result."}`;
    setUploadMessage(error.name === "TypeError" ? "Could not connect to the analysis service." : "Analysis service returned an error. Review the message above.", "error");
  } finally { previewWrap.classList.remove("is-scanning"); analyzeButton.disabled = !selectedFile; analyzeButton.innerHTML = 'Analyze Crop <span>\u2197</span>'; }
});

function renderDiagnosis(data) {
  if (!data || typeof data !== "object" || typeof data.uncertain !== "boolean") throw new Error("The analysis service returned an invalid response.");
  const hi = $("#analysis-language").value === "hi";
  if (!data.uncertain && !(hi ? data.disease_hi : data.disease)) throw new Error("The analysis response is incomplete. Please try again.");
  const pick = (en, hindi) => hi ? (hindi || en || "") : (en || hindi || "");
  const labels = hi ? {title:"फसल का प्रारंभिक आकलन",crop:"किसान द्वारा चुनी फसल",identifiedCrop:"फ़ोटो में दिखती फसल",problem:"संभावित समस्या",note:"अनिश्चितता",symptoms:"दिखने वाले लक्षण",severity:"संभावित गंभीरता",confidence:"आकलन का भरोसा",causes:"अन्य संभावित कारण",actions:"अगले सुरक्षित कदम",prevention:"बचाव",expert:"कृषि विशेषज्ञ से कब मिलें",saved:"यह आकलन आपके खाते में सहेजा गया है। फ़ोटो सहेजी नहीं गई।",unsaved:"यह केवल AI का प्रारंभिक आकलन है। फ़ोटो सहेजी नहीं गई। कोई सत्यापित स्थानीय उपचार स्रोत जुड़ा नहीं है; उपचार की पुष्टि कृषि विशेषज्ञ से करें।",chat:"इस रिपोर्ट पर Krishi AI से पूछें",ask:"विशेषज्ञ से पूछें",again:"दूसरी फ़ोटो का विश्लेषण करें"} : {title:"Preliminary crop assessment",crop:"Farmer-selected crop",identifiedCrop:"Crop visible in photo",problem:"Possible problem",note:"Uncertainty",symptoms:"Visible symptoms",severity:"Estimated severity",confidence:"Assessment confidence",causes:"Other possible causes",actions:"Safe next steps",prevention:"Prevention",expert:"When to contact an agriculture expert",saved:"This assessment was saved to your account. The photo was not saved.",unsaved:"This is a preliminary AI assessment. The photo was not saved. No verified local treatment source is connected; confirm treatment with an agriculture expert.",chat:"Ask Krishi AI about this report",ask:"Ask an expert",again:"Analyze another photo"};
  const panel = document.createElement("article"); panel.className = "diagnosis-result";
  const title = document.createElement("h3"); title.textContent = labels.title; panel.append(title);
  const line = (label, text) => { if (!text) return; const p = document.createElement("p"), strong = document.createElement("strong"); strong.textContent = label + ": "; p.append(strong, document.createTextNode(text)); panel.append(p); };
  const list = (label, items) => { const values = Array.isArray(items) ? items.filter(item => typeof item === "string" && item.trim()) : []; if (!values.length) return; const section = document.createElement("section"), heading = document.createElement("h4"), ul = document.createElement("ul"); heading.textContent = label; section.append(heading); values.forEach(item => { const li = document.createElement("li"); li.textContent = item; ul.append(li); }); section.append(ul); panel.append(section); };
  line(labels.crop, $("#analysis-crop").value);
  line(labels.identifiedCrop, pick(data.identified_crop, data.identified_crop_hi));
  line(labels.problem, data.uncertain ? (hi ? "अभी स्पष्ट नहीं" : "Not clear yet") : pick(data.disease, data.disease_hi));
  if (data.uncertain) line(labels.note, pick(data.uncertainty_message, data.uncertainty_message_hi) || (hi ? "इस फ़ोटो से समस्या की भरोसेमंद पहचान नहीं हो सकी।" : "The photo does not support a reliable identification."));
  list(labels.symptoms, pick(data.symptoms, data.symptoms_hi));
  if (data.severity && data.severity !== "unknown") line(labels.severity, pick(data.severity, data.severity_hi) || data.severity);
  const confidence = {low: hi ? "कम" : "Low", moderate: hi ? "मध्यम" : "Moderate", high: hi ? "अधिक" : "High"}[data.confidence_level];
  if (confidence) line(labels.confidence, confidence + (pick(data.confidence_note, data.confidence_note_hi) ? " — " + pick(data.confidence_note, data.confidence_note_hi) : ""));
  list(labels.causes, pick(data.possible_causes, data.possible_causes_hi));
  list(labels.actions, pick(data.recommendations, data.recommendations_hi));
  list(labels.prevention, pick(data.prevention, data.prevention_hi));
  line(labels.expert, pick(data.expert_when, data.expert_when_hi));
  const note = document.createElement("p"); note.className = "diagnosis-note"; note.textContent = data.reportSaved ? labels.saved : data.reportSaveError ? data.reportSaveError + (hi ? " फ़ोटो सहेजी नहीं गई।" : " The photo was not saved.") : labels.unsaved; panel.append(note);
  const actions = document.createElement("div"); actions.className = "diagnosis-actions";
  const again = document.createElement("button"); again.type = "button"; again.className = "button button-outline"; again.textContent = labels.again; again.addEventListener("click", () => { clearSelection(); result.textContent = hi ? "दूसरी साफ़ फ़ोटो चुनें।" : "Choose another clear crop photo."; $("#detection").scrollIntoView({behavior:"smooth"}); }); actions.append(again);
  const chat = document.createElement("button"); chat.type = "button"; chat.className = "button button-dark"; chat.textContent = labels.chat; chat.addEventListener("click", () => { const summary = JSON.stringify({crop:$("#analysis-crop").value,identifiedCrop:pick(data.identified_crop,data.identified_crop_hi),uncertain:data.uncertain,problem:pick(data.disease,data.disease_hi),symptoms:pick(data.symptoms,data.symptoms_hi),causes:pick(data.possible_causes,data.possible_causes_hi),actions:pick(data.recommendations,data.recommendations_hi),severity:data.severity}); window.krishiChat?.openWithAnalysis?.({summary,language:hi?"hi":"en"}); }); actions.append(chat);
  const expert = document.createElement("button"); expert.type = "button"; expert.className = "button button-outline"; expert.textContent = labels.ask; expert.addEventListener("click", () => { const form = $("#expert-form"); form.elements.namedItem("crop").value = $("#analysis-crop").value; form.elements.namedItem("details").value = "Preliminary AI assessment: " + (data.disease || "unclear result") + ". Please review the crop and symptoms."; $("#experts").scrollIntoView({behavior:"smooth"}); form.elements.namedItem("details").focus(); }); actions.append(expert);
  panel.append(actions); result.replaceChildren(panel);
}

function renderDiagnosisLegacy(data) {
  if (!data || typeof data !== "object") throw new Error("The analysis service returned an invalid response.");
  if (data.confidence !== undefined && (typeof data.confidence !== "number" || data.confidence < 0 || data.confidence > 1)) throw new Error("The service returned an invalid confidence value.");
  if (!data.uncertain && (typeof data.disease !== "string" || !data.disease.trim())) throw new Error("The service response has no diagnosis. Please try again or ask an expert.");
  const panel = document.createElement("article"); panel.className = "diagnosis-result";
  const title = document.createElement("h3"); title.textContent = "Crop assessment / Ã Â¤Â«Ã Â¤Â¸Ã Â¤Â² Ã Â¤â€¢Ã Â¤Â¾ Ã Â¤â€ Ã Â¤â€¢Ã Â¤Â²Ã Â¤Â¨"; panel.append(title);
  const line = (labelEn, labelHi, valueEn, valueHi) => {
    if (!valueEn && !valueHi) return;
    const p = document.createElement("p"), strong = document.createElement("strong");
    strong.textContent = `${labelEn} / ${labelHi}: `; p.append(strong, document.createTextNode([valueEn, valueHi].filter(Boolean).join(" / "))); panel.append(p);
  };
  line("Crop", "Ã Â¤Â«Ã Â¤Â¸Ã Â¤Â²", $("#analysis-crop").value, data.crop_hi);
  line("Possible problem", "Ã Â¤Â¸Ã Â¤â€šÃ Â¤Â­Ã Â¤Â¾Ã Â¤ÂµÃ Â¤Â¿Ã Â¤Â¤ Ã Â¤Â¸Ã Â¤Â®Ã Â¤Â¸Ã Â¥ÂÃ Â¤Â¯Ã Â¤Â¾", data.disease, data.disease_hi);
  if (data.uncertain) line("Note", "Ã Â¤Â§Ã Â¥ÂÃ Â¤Â¯Ã Â¤Â¾Ã Â¤Â¨ Ã Â¤Â¦Ã Â¥â€¡Ã Â¤â€š", data.uncertainty_message || "The image could not be identified confidently. Try a clearer photo or contact an agricultural expert.", data.uncertainty_message_hi);
  const listField = (key, keyHi, labelEn, labelHi) => {
    const en = Array.isArray(data[key]) ? data[key].filter(x => typeof x === "string" && x.trim()) : [];
    const hi = Array.isArray(data[keyHi]) ? data[keyHi].filter(x => typeof x === "string" && x.trim()) : [];
    if (!en.length && !hi.length) return;
    const section = document.createElement("section"), heading = document.createElement("h4"); heading.textContent = `${labelEn} / ${labelHi}`; section.append(heading);
    const ul = document.createElement("ul"); [...en.map((v, i) => ({ en: v, hi: hi[i] })), ...hi.slice(en.length).map(v => ({ hi: v }))].forEach(item => { const li = document.createElement("li"); li.textContent = [item.en, item.hi].filter(Boolean).join(" / "); ul.append(li); });
    section.append(ul); panel.append(section);
  };
  listField("symptoms", "symptoms_hi", "Visible symptoms", "Ã Â¤Â¦Ã Â¤Â¿Ã Â¤â€“Ã Â¤Â¨Ã Â¥â€¡ Ã Â¤ÂµÃ Â¤Â¾Ã Â¤Â²Ã Â¥â€¡ Ã Â¤Â²Ã Â¤â€¢Ã Â¥ÂÃ Â¤Â·Ã Â¤Â£");
  if (["low", "moderate", "medium", "high", "severe"].includes(String(data.severity).toLowerCase())) line("Severity (model estimate)", "Ã Â¤â€”Ã Â¤â€šÃ Â¤Â­Ã Â¥â‚¬Ã Â¤Â°Ã Â¤Â¤Ã Â¤Â¾ (Ã Â¤Â®Ã Â¥â€°Ã Â¤Â¡Ã Â¤Â² Ã Â¤â€¢Ã Â¤Â¾ Ã Â¤â€¦Ã Â¤Â¨Ã Â¥ÂÃ Â¤Â®Ã Â¤Â¾Ã Â¤Â¨)", data.severity, data.severity_hi);
  listField("possible_causes", "possible_causes_hi", "Possible causes", "Ã Â¤Â¸Ã Â¤â€šÃ Â¤Â­Ã Â¤Â¾Ã Â¤ÂµÃ Â¤Â¿Ã Â¤Â¤ Ã Â¤â€¢Ã Â¤Â¾Ã Â¤Â°Ã Â¤Â£");
  listField("recommendations", "recommendations_hi", "Next steps", "Ã Â¤â€¦Ã Â¤â€”Ã Â¤Â²Ã Â¥â€¡ Ã Â¤â€¢Ã Â¤Â¦Ã Â¤Â®");
  listField("prevention", "prevention_hi", "Prevention and IPM", "Ã Â¤Â¬Ã Â¤Å¡Ã Â¤Â¾Ã Â¤Âµ Ã Â¤â€Ã Â¤Â° IPM");
  line("Ask an expert when", "Ã Â¤ÂµÃ Â¤Â¿Ã Â¤Â¶Ã Â¥â€¡Ã Â¤Â·Ã Â¤Å“Ã Â¥ÂÃ Â¤Å¾ Ã Â¤Â¸Ã Â¥â€¡ Ã Â¤â€¢Ã Â¤Â¬ Ã Â¤Â®Ã Â¤Â¿Ã Â¤Â²Ã Â¥â€¡Ã Â¤â€š", data.expert_when, data.expert_when_hi);
  if (data.confidence !== undefined) line("Model confidence", "Ã Â¤Â®Ã Â¥â€°Ã Â¤Â¡Ã Â¤Â² Ã Â¤â€¢Ã Â¤Â¾ Ã Â¤Â­Ã Â¤Â°Ã Â¥â€¹Ã Â¤Â¸Ã Â¤Â¾", `${(data.confidence * 100).toFixed(1)}%`, data.confidence_hi);
  const note = document.createElement("p"); note.className = "diagnosis-note"; note.textContent = data.reportSaved ? "AI assessment only. This report was saved without the photo." : data.reportSaveError ? `${data.reportSaveError} The photo was not stored.` : "AI assessment only; confirm uncertain symptoms with a local agriculture expert. Use only crop-specific treatment guidance from a trusted source."; panel.append(note);
  const actions = document.createElement("div"); actions.className = "diagnosis-actions";
  const retake = document.createElement("button"); retake.type = "button"; retake.className = "button button-outline"; retake.textContent = "Retake photo"; retake.addEventListener("click", () => { clearSelection(); openCamera(); }); actions.append(retake);
  const expert = document.createElement("button"); expert.type = "button"; expert.className = "button button-dark"; expert.textContent = "Ask an expert"; expert.addEventListener("click", () => { const form = $("#expert-form"); form.elements.namedItem("crop").value = $("#analysis-crop").value; form.elements.namedItem("details").value = `AI assessment: ${data.disease || "unclear result"}. Please review the crop photo and symptoms.`; $("#experts").scrollIntoView({ behavior: "smooth" }); form.elements.namedItem("details").focus(); }); actions.append(expert);
  panel.append(actions); result.replaceChildren(panel);
}

async function refreshBackendHealth() {
  try {
    const response = await fetchWithTimeout(apiUrl(CONFIG.ENDPOINTS.health), { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error("Backend health check failed.");
    serviceHealth = await response.json();
    const limits = serviceHealth.limits || {};
    if (Number.isFinite(limits.maxImageBytes) && limits.maxImageBytes > 0) CONFIG.MAX_IMAGE_BYTES = limits.maxImageBytes;
    if (Number.isFinite(limits.minImageDimension) && limits.minImageDimension >= 256) CONFIG.MIN_IMAGE_DIMENSION = limits.minImageDimension;
    if (Number.isFinite(limits.maxImageDimension) && limits.maxImageDimension >= CONFIG.MIN_IMAGE_DIMENSION) CONFIG.MAX_IMAGE_DIMENSION = limits.maxImageDimension;
    databaseRecordsEnabled = Boolean(currentUser && serviceHealth.services?.database?.reportsEnabled === true);
    if (!databaseRecordsEnabled) persistentDataLoaded = false;
    else if (!persistentDataLoaded) { persistentDataLoaded = true; void loadPersistentData(); }
    return serviceHealth;
  } catch { serviceHealth = null; return null; }
}
let selectedWeatherLocation = null;
function setWeatherMessage(text) { $("#weather-location-message").textContent = text; }
function displayWeatherError(error) {
  const state = $("#weather-state"); state.classList.remove("is-loading");
  state.innerHTML = `<span class="weather-state-icon">!</span><strong>Weather data unavailable</strong><p>${escapeHtml(error)}</p>`;
  $("#weather-foot-status").textContent = "No current weather loaded";
}
async function loadWeatherForLocation(location) {
  if (!serviceHealth) await refreshBackendHealth();
  if (!serviceHealth) { displayWeatherError("Backend is unavailable. Your location was not sent."); return; }
  if (!serviceHealth.services?.weather?.configured) { displayWeatherError("Set VISUAL_CROSSING_API_KEY on the backend to enable Visual Crossing weather."); return; }
  selectedWeatherLocation = location;
  $("#weather-location").textContent = location.label;
  $("#weather-history-results").replaceChildren();
  $("#weather-history-message").textContent = "Choose a past date range. Historical access depends on your Visual Crossing plan.";
  const state = $("#weather-state"); state.classList.add("is-loading");
  state.innerHTML = '<span class="weather-state-icon">Ã¢â€”Å’</span><strong>Loading real weather dataÃ¢â‚¬Â¦</strong><p>Requesting current conditions and forecast.</p>';
  $("#weather-foot-status").textContent = "Requesting provider data";
  const params = new URLSearchParams({ lat: String(location.lat), lon: String(location.lon), label: location.label, language: document.documentElement.lang === "hi" ? "hi" : "en" });
  const loadEndpoint = async endpoint => {
    const response = await fetchWithTimeout(apiUrl(`${endpoint}?${params}`), { headers: { Accept: "application/json" }, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Weather service returned ${response.status}.`);
    return data;
  };
  const [currentResult, forecastResult] = await Promise.allSettled([loadEndpoint(CONFIG.ENDPOINTS.weatherCurrent), loadEndpoint(CONFIG.ENDPOINTS.weatherForecast)]);
  state.classList.remove("is-loading");
  if (currentResult.status === "fulfilled") renderCurrentWeather(currentResult.value);
  else displayWeatherError(currentResult.reason.message || "Current conditions could not be loaded.");
  if (forecastResult.status === "fulfilled") renderWeatherForecast(forecastResult.value);
  else { $("#weather-forecast").replaceChildren(); if (currentResult.status === "fulfilled") $("#weather-foot-status").textContent += " ? forecast unavailable"; }
}
function renderCurrentWeather(weather) {
  const state = $("#weather-state");
  const stats = $$(".weather-stats strong");
  const unavailable = "Not reported";
  if (weather.stale) {
    state.innerHTML = '<span class="weather-state-icon">!</span><strong>Provider data is too old to show as current</strong><p>Refresh later; stale values are hidden.</p>';
    stats[0].textContent = stats[1].textContent = stats[2].textContent = "Not reported";
    $("#weather-extra").textContent = "";
    $("#weather-foot-status").textContent = "Stale provider response hidden";
  } else {
    state.innerHTML = `<span class="weather-state-icon">Ã¢ËœÂ</span><strong>${escapeHtml(weather.summary || "Current conditions")}</strong><p>${escapeHtml(weather.location || selectedWeatherLocation?.label || "Selected location")}</p>`;
    stats[0].textContent = Number.isFinite(weather.temperature) ? `${weather.temperature.toFixed(1)} Ã‚Â°C` : unavailable;
    stats[1].textContent = Number.isFinite(weather.humidity) ? `${weather.humidity}%` : unavailable;
    stats[2].textContent = Number.isFinite(weather.rainfallMm) ? `${weather.rainfallMm} mm (${weather.rainfallPeriod})` : unavailable;
    const details = [];
    if (Number.isFinite(weather.windSpeedMs)) details.push(`Wind ${weather.windSpeedMs} m/s`);
    if (Number.isFinite(weather.feelsLike)) details.push(`Feels like ${weather.feelsLike.toFixed(1)} Ã‚Â°C`);
    $("#weather-extra").textContent = details.join(" ? ");
    $("#weather-foot-status").textContent = "Live provider observation received";
  }
  const observed = weather.observedAt ? new Date(weather.observedAt) : null;
  $("#weather-updated").textContent = `${observed ? `Observed ${observed.toLocaleString()}` : "Provider timestamp unavailable"} ? ${weather.source || "Weather provider"}`;
}
function renderWeatherForecast(forecast) {
  const target = $("#weather-forecast"); target.replaceChildren();
  for (const day of forecast.days || []) {
    const card = document.createElement("article"); card.className = "weather-forecast-day";
    const date = document.createElement("strong");
    const parsedDate = new Date(`${day.date}T12:00:00`);
    date.textContent = Number.isNaN(parsedDate.getTime()) ? "Forecast" : parsedDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const summary = document.createElement("span"); summary.textContent = day.summary || "Conditions unavailable";
    const temps = document.createElement("span"); temps.className = "forecast-temp";
    temps.textContent = Number.isFinite(day.minTemperature) && Number.isFinite(day.maxTemperature) ? `${day.minTemperature.toFixed(0)}Ã‚Â° / ${day.maxTemperature.toFixed(0)}Ã‚Â°C` : "Temp unavailable";
    const rain = document.createElement("span"); rain.className = "forecast-rain";
    const rainValues = [];
    if (Number.isFinite(day.rainfallMm)) rainValues.push(`${day.rainfallMm} mm`);
    if (Number.isFinite(day.precipitationProbability)) rainValues.push(`${day.precipitationProbability}%`);
    rain.textContent = rainValues.length ? `Rain ${rainValues.join(" ? ")}` : "Rain not reported";
    card.append(date, summary, temps, rain); target.append(card);
  }
  $("#weather-updated").textContent += ` · Forecast: ${forecast.source || "Visual Crossing"}`;
}
function initializeWeatherHistoryDates() {
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  const toValue = end.toISOString().slice(0, 10);
  const fromInput = $("#weather-history-from"), toInput = $("#weather-history-to");
  fromInput.max = toValue; toInput.max = toValue;
  if (!fromInput.value) fromInput.value = start.toISOString().slice(0, 10);
  if (!toInput.value) toInput.value = toValue;
}
function renderWeatherHistory(history) {
  const target = $("#weather-history-results"); target.replaceChildren();
  for (const day of history.days || []) {
    const card = document.createElement("article"); card.className = "weather-history-day";
    const date = document.createElement("strong");
    const parsedDate = new Date(`${day.date}T12:00:00`);
    date.textContent = Number.isNaN(parsedDate.getTime()) ? day.date : parsedDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const condition = document.createElement("span"); condition.textContent = day.summary || "Conditions unavailable";
    const temps = document.createElement("span");
    temps.textContent = Number.isFinite(day.minTemperature) && Number.isFinite(day.maxTemperature) ? `${day.minTemperature.toFixed(0)}° / ${day.maxTemperature.toFixed(0)}°C` : "Temp unavailable";
    const rain = document.createElement("span"); rain.textContent = Number.isFinite(day.rainfallMm) ? `Rain ${day.rainfallMm} mm` : "Rain not reported";
    card.append(date, condition, temps, rain); target.append(card);
  }
  $("#weather-history-message").textContent = history.days?.length ? `Historical observations · ${history.source}` : "No historical daily data was returned for this period.";
}
async function loadWeatherHistory(event) {
  event.preventDefault();
  const message = $("#weather-history-message"), target = $("#weather-history-results");
  if (!selectedWeatherLocation) { message.textContent = "Choose a location before loading historical weather."; return; }
  const from = $("#weather-history-from").value, to = $("#weather-history-to").value;
  const button = $("#weather-history-submit"); button.disabled = true; target.replaceChildren(); message.textContent = "Loading historical weather…";
  try {
    const params = new URLSearchParams({ lat: String(selectedWeatherLocation.lat), lon: String(selectedWeatherLocation.lon), from, to, label: selectedWeatherLocation.label, language: document.documentElement.lang === "hi" ? "hi" : "en" });
    const response = await fetchWithTimeout(apiUrl(`${CONFIG.ENDPOINTS.weatherHistory}?${params}`), { headers: { Accept: "application/json" }, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Historical weather returned ${response.status}.`);
    renderWeatherHistory(data);
  } catch (error) { message.textContent = error.message || "Historical weather could not be loaded."; }
  finally { button.disabled = false; }
}
initializeWeatherHistoryDates();
$("#weather-history-form").addEventListener("submit", loadWeatherHistory);
async function searchWeatherLocation(event) {
  event.preventDefault();
  if (!serviceHealth) await refreshBackendHealth();
  if (!serviceHealth) { setWeatherMessage("Backend unavailable. Check the server and retry."); return; }
  if (!serviceHealth.services?.weather?.configured) { setWeatherMessage("Weather is not connected. Configure VISUAL_CROSSING_API_KEY on the backend."); return; }
  const query = $("#weather-location-query").value.trim();
  const button = $("#weather-search"); button.disabled = true; setWeatherMessage("Searching Visual Crossing locations…");
  try {
    const params = new URLSearchParams({ q: query });
    const response = await fetchWithTimeout(apiUrl(`${CONFIG.ENDPOINTS.weatherGeocode}?${params}`), { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Location search returned ${response.status}.`);
    const results = $("#weather-location-results"); results.replaceChildren();
    if (!Array.isArray(data.locations) || !data.locations.length) { setWeatherMessage("No matching location found. Try a nearby town or include the state."); return; }
    setWeatherMessage("Choose the correct location:");
    for (const item of data.locations) {
      const choice = document.createElement("button"); choice.type = "button"; choice.setAttribute("role", "listitem");
      const label = [item.name, item.state, item.country].filter(Boolean).join(", "); choice.textContent = label;
      choice.addEventListener("click", () => { results.replaceChildren(); setWeatherMessage(""); void loadWeatherForLocation({ lat: item.lat, lon: item.lon, label }); });
      results.append(choice);
    }
  } catch (error) { setWeatherMessage(error.message || "Location search failed. Please retry."); }
  finally { button.disabled = false; }
}
$("#weather-location-form").addEventListener("submit", searchWeatherLocation);
$("#weather-geolocate").addEventListener("click", async event => {
  if (!serviceHealth) await refreshBackendHealth();
  if (!serviceHealth?.services?.weather?.configured) { setWeatherMessage("Weather is not connected. Configure VISUAL_CROSSING_API_KEY on the backend."); return; }
  if (!navigator.geolocation) { setWeatherMessage("Location access is unavailable. Search for your town instead."); return; }
  const button = event.currentTarget; button.disabled = true; setWeatherMessage("Waiting for your location permissionÃ¢â‚¬Â¦");
  navigator.geolocation.getCurrentPosition(position => {
    button.disabled = false; setWeatherMessage("");
    const { latitude: lat, longitude: lon } = position.coords;
    void loadWeatherForLocation({ lat, lon, label: `Farm location (${lat.toFixed(3)}, ${lon.toFixed(3)})` });
  }, error => {
    button.disabled = false;
    setWeatherMessage(error.code === 1 ? "Location permission was not granted. Search for your town instead." : "Could not get your location. Search for your town instead.");
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
});
$("#weather-refresh").addEventListener("click", () => selectedWeatherLocation ? void loadWeatherForLocation(selectedWeatherLocation) : setWeatherMessage("Choose a location before refreshing weather."));
void refreshBackendHealth();
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }

let map = null;
let markerLayer = null;
let streetTileLayer = null;
let satelliteTileLayer = null;
let fallbackStreetTileLayer = null;
let streetFallbackActive = false;
let activeTileLayer = null;
let userLocationMarker = null;
let embeddedMapFrame = $('#risk-map-canvas iframe.map-embedded-frame');
let mapConfiguration = { satelliteEnabled: false, satelliteApiKey: null };
let currentBasemap = 'street';
let leafletLoadPromise = null;
function loadLeafletScript(urls, index = 0) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => script.onerror?.(), 12000);
    script.src = urls[index];
    script.integrity = index === 0 ? 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=' : '';
    script.crossOrigin = 'anonymous';
    script.onload = () => { window.clearTimeout(timeout); window.L ? resolve(window.L) : reject(new Error('Map library did not initialize.')); };
    script.onerror = () => {
      window.clearTimeout(timeout);
      script.remove();
      if (index + 1 < urls.length) loadLeafletScript(urls, index + 1).then(resolve, reject);
      else reject(new Error('Map library could not load from either map CDN. Check your connection or content blocker.'));
    };
    document.head.append(script);
  });
}
function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet-style]')) {
      const style = document.createElement("link");
      style.rel = "stylesheet"; style.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      style.integrity = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="; style.crossOrigin = ""; style.dataset.leafletStyle = "true";
      style.onerror = () => { style.onerror = null; style.integrity = ''; style.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'; };
      document.head.append(style);
    }
    loadLeafletScript([
      'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
      'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'
    ]).then(resolve, reject);
  }).catch(error => { leafletLoadPromise = null; throw error; });
  return leafletLoadPromise;
}
function setMapStatus(message) { $('#map-status').textContent = message; }
function showEmbeddedOpenStreetMap(latitude = 22.5, longitude = 79, zoom = 4) {
  const span = 180 / (2 ** zoom);
  const bounds = [longitude - span, latitude - span / 2, longitude + span, latitude + span / 2]
    .map((value, index) => Math.max(index % 2 === 0 ? -180 : -85, Math.min(index % 2 === 0 ? 180 : 85, value)));
  const query = new URLSearchParams({ bbox: bounds.join(','), layer: 'mapnik', marker: `${latitude},${longitude}` });
  embeddedMapFrame = document.createElement('iframe');
  embeddedMapFrame.className = 'map-embedded-frame';
  embeddedMapFrame.title = 'Interactive OpenStreetMap view';
  embeddedMapFrame.loading = 'eager';
  embeddedMapFrame.referrerPolicy = 'strict-origin-when-cross-origin';
  embeddedMapFrame.src = `https://www.openstreetmap.org/export/embed.html?${query}`;
  $('#risk-map-canvas').replaceChildren(embeddedMapFrame);
  $('#map-empty').hidden = true;
  setMapStatus('OpenStreetMap fallback · standard street map');
}
function switchBasemap(layerName, animate = true) {
  if (!map || (layerName === 'satellite' && (!mapConfiguration.satelliteEnabled || !satelliteTileLayer))) return;
  if (activeTileLayer && map.hasLayer(activeTileLayer)) map.removeLayer(activeTileLayer);
  currentBasemap = layerName;
  activeTileLayer = layerName === 'satellite' ? satelliteTileLayer : (streetFallbackActive && fallbackStreetTileLayer ? fallbackStreetTileLayer : streetTileLayer);
  if (activeTileLayer) activeTileLayer.addTo(map);
  const selector = $('#map-basemap'); if (selector) selector.value = layerName;
  const motionAllowed = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && motionAllowed && map.getZoom() < 7) map.flyTo(map.getCenter(), 7, { animate: true, duration: 1.15 });
  map.invalidateSize(); $('#map-empty').hidden = true;
  setMapStatus(`${layerName === 'satellite' ? 'Satellite imagery' : 'Street map'} Â· no live crop-risk layer`);
}
async function loadMapConfiguration() {
  try {
    const response = await fetchWithTimeout(apiUrl('/api/map/config'), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      if (config && typeof config.satelliteEnabled === 'boolean') mapConfiguration = config;
    }
  } catch { /* Keep the OpenStreetMap basemap if optional provider config is unavailable. */ }
  if (typeof mapConfiguration.satelliteApiKey !== 'string' || !mapConfiguration.satelliteApiKey.trim()) {
    mapConfiguration = { ...mapConfiguration, satelliteEnabled: false, satelliteApiKey: null };
  }
}
async function loadRiskMap() {
  const status = $('#map-status'), empty = $('#map-empty');
  const mapShell = $('#risk-map .map-shell'); mapShell.classList.add('is-loading');
  try {
    if (!map && !embeddedMapFrame) showEmbeddedOpenStreetMap();
    status.textContent = 'Loading interactive map controls…';
    await ensureLeaflet();
    if (!serviceHealth) await refreshBackendHealth();
    await loadMapConfiguration();
    if (!map) {
      const motionAllowed = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      embeddedMapFrame?.remove();
      embeddedMapFrame = null;
      map = L.map('risk-map-canvas', { scrollWheelZoom: false, zoomAnimation: motionAllowed, fadeAnimation: motionAllowed, zoomSnap: .5, minZoom: 2 }).setView([22.5, 79], 4);
      markerLayer = L.layerGroup().addTo(map);
    }
    if (!streetTileLayer) {
      streetTileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
        maxZoom: 19, keepBuffer: 1, updateWhenIdle: true, updateWhenZooming: false
      });
      let initialTileErrors = 0;
      let initialTileLoaded = false;
      let usingStreetFallback = false;
      streetTileLayer.on('tileerror', () => {
        if (currentBasemap !== 'street') return;
        initialTileErrors += 1;
        if (initialTileLoaded || usingStreetFallback || initialTileErrors < 3) return;
        usingStreetFallback = true;
        streetFallbackActive = true;
        if (!fallbackStreetTileLayer) {
          fallbackStreetTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 20, keepBuffer: 1, updateWhenIdle: true, updateWhenZooming: false,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>'
          });
          fallbackStreetTileLayer.on('tileerror', () => {
            if (activeTileLayer !== fallbackStreetTileLayer) return;
            map.remove(); map = null; activeTileLayer = null;
            showEmbeddedOpenStreetMap();
          });
          fallbackStreetTileLayer.on('tileload', () => {
            if (activeTileLayer === fallbackStreetTileLayer) empty.hidden = true;
          });
        }
        if (map.hasLayer(streetTileLayer)) map.removeLayer(streetTileLayer);
        activeTileLayer = fallbackStreetTileLayer;
        fallbackStreetTileLayer.addTo(map);
        setMapStatus('Using alternate street map · CARTO');
      });
      streetTileLayer.on('tileload', () => {
        initialTileLoaded = true;
        if (currentBasemap === 'street' && activeTileLayer === streetTileLayer) empty.hidden = true;
      });
    }
    const satelliteOption = $('#map-basemap').querySelector('option[value="satellite"]');
    satelliteOption.disabled = !mapConfiguration.satelliteEnabled;
    satelliteOption.textContent = mapConfiguration.satelliteEnabled ? 'Satellite imagery Â· MapTiler' : 'Satellite imagery Â· API key needed';
    if (mapConfiguration.satelliteEnabled && !satelliteTileLayer) {
      const attribution = '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
      satelliteTileLayer = L.tileLayer(`https://api.maptiler.com/maps/satellite-v4/{z}/{x}/{y}.jpg?key=${encodeURIComponent(mapConfiguration.satelliteApiKey)}`, {
        attribution, tileSize: 512, zoomOffset: -1, maxZoom: 20, keepBuffer: 1, updateWhenIdle: true, updateWhenZooming: false, crossOrigin: true
      });
      satelliteTileLayer.on('tileerror', () => {
        if (currentBasemap !== 'satellite' || $('#map-basemap').dataset.failed === 'true') return;
        $('#map-basemap').dataset.failed = 'true'; switchBasemap('street', false);
        setMapStatus('Satellite tiles unavailable Â· showing OpenStreetMap');
        $('#map-empty-title').textContent = 'Satellite imagery is unavailable';
        $('#map-empty-copy').textContent = 'Check the MapTiler key and its allowed website domains. The street map remains available.';
        empty.hidden = false;
      });
      satelliteTileLayer.on('tileload', () => { if (currentBasemap === 'satellite') empty.hidden = true; });
    }
    if (!activeTileLayer && mapConfiguration.satelliteEnabled) currentBasemap = 'satellite';
    if (currentBasemap === 'satellite' && !mapConfiguration.satelliteEnabled) currentBasemap = 'street';
    $('#map-basemap').value = currentBasemap;
    if (!activeTileLayer || (currentBasemap === 'satellite' && activeTileLayer !== satelliteTileLayer)) switchBasemap(currentBasemap, false);
    else if (!map.hasLayer(activeTileLayer)) activeTileLayer.addTo(map);
    map.invalidateSize(); markerLayer.clearLayers();
    if (!serviceHealth?.services?.riskMap?.configured) {
      setMapStatus(`${currentBasemap === 'satellite' ? 'Satellite imagery' : 'Street map'} Â· no live crop-risk layer`);
      empty.hidden = true; mapShell.classList.remove('is-loading'); return;
    }
    setMapStatus('Loading verified advisoriesâ€¦');
    const response = await fetchWithTimeout(`${CONFIG.API_BASE_URL}${CONFIG.ENDPOINTS.riskMap}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Risk map service returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.locations)) throw new Error('Risk map response is incomplete.');
    const locations = data.locations.filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180);
    locations.forEach(point => L.circleMarker([point.lat, point.lng], { radius: 7, color: '#f5fff2', weight: 2, fillColor: '#2eaa64', fillOpacity: .9, className: 'verified-risk-marker' }).addTo(markerLayer).bindPopup(escapeHtml(point.label || 'Verified farm location')));
    empty.hidden = true; setMapStatus(locations.length ? `${locations.length} verified location(s)` : 'No verified locations returned');
    map.invalidateSize();
  } catch (error) {
    if (!map) {
      showEmbeddedOpenStreetMap();
    } else {
      status.textContent = 'Map unavailable'; empty.hidden = false;
      $('#map-empty-title').textContent = 'Regional map unavailable';
      $('#map-empty-copy').textContent = `${error.message} Check your internet connection and retry.`;
    }
  }
  mapShell.classList.remove('is-loading');
}
$('#map-basemap').addEventListener('change', event => {
  if (event.target.value === 'satellite' && !mapConfiguration.satelliteEnabled) { event.target.value = 'street'; setMapStatus('Satellite layer needs MAPTILER_API_KEY'); return; }
  delete event.target.dataset.failed; switchBasemap(event.target.value);
});
$('#map-locate').addEventListener('click', event => {
  const button = event.currentTarget;
  if (!navigator.geolocation) { setMapStatus('Device location is unavailable'); return; }
  button.disabled = true; setMapStatus('Waiting for location permissionâ€¦');
  navigator.geolocation.getCurrentPosition(position => {
    button.disabled = false;
    const { latitude, longitude } = position.coords;
    if (embeddedMapFrame) {
      showEmbeddedOpenStreetMap(latitude, longitude, 12);
      setMapStatus('Your location · shown on this device only');
      return;
    }
    if (!map) { setMapStatus('Map is still loading'); return; }
    const icon = L.divIcon({ className: '', html: '<span class="user-location-icon" aria-hidden="true"></span>', iconSize: [22, 22], iconAnchor: [11, 11] });
    if (userLocationMarker) map.removeLayer(userLocationMarker);
    userLocationMarker = L.marker([latitude, longitude], { icon, keyboard: true, title: 'Your current location', riseOnHover: true }).addTo(map)
      .bindPopup('Your current device location. It is shown only on this device and is not saved or sent by this map.');
    map.flyTo([latitude, longitude], Math.max(map.getZoom(), 12), { animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 1.25 });
    setMapStatus('Your location Â· shown on this device only');
  }, error => {
    button.disabled = false;
    setMapStatus(error.code === 1 ? 'Location permission was not granted' : 'Could not read device location');
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
});
$('#map-retry').addEventListener('click', loadRiskMap);
const startMap = () => { void loadRiskMap(); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startMap, { once: true });
else startMap();
document.addEventListener("DOMContentLoaded", () => {
  const video = $(".hero-video");
  video.addEventListener("error", () => { video.hidden = true; });
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) video.pause();
});

// Local prototype modules: data stays on this device and is never presented as verified analysis.
const localStore = {
  read(key, fallback = []) { try { return JSON.parse(localStorage.getItem(`km_${key}`)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(`km_${key}`, JSON.stringify(value)); return true; } catch { return false; } }
};
async function loadPersistentData() {
  if (!currentUser || !serviceHealth?.services?.database?.reportsEnabled) { databaseRecordsEnabled = false; renderCrops(); renderRequests(); renderServerAlerts(); return; }
  try {
    const sessionResponse = await fetchWithTimeout(apiUrl('/api/session'), { headers: { Accept: 'application/json' } });
    if (!sessionResponse.ok) throw new Error('Private record session could not be started.');
    const cropsResponse = await fetchWithTimeout(apiUrl('/api/crops'), { headers: { Accept: 'application/json' } });
    const crops = await cropsResponse.json(); if (!cropsResponse.ok || crops.recordsEnabled !== true) throw new Error(crops.error || 'Crop storage is unavailable.');
    const [reportsResponse, alertsResponse] = await Promise.all([
      fetchWithTimeout(apiUrl('/api/reports?limit=50'), { headers: { Accept: 'application/json' } }),
      fetchWithTimeout(apiUrl('/api/alerts'), { headers: { Accept: 'application/json' } })
    ]);
    const reports = await reportsResponse.json(), alerts = await alertsResponse.json();
    if (!reportsResponse.ok || !alertsResponse.ok) throw new Error(reports.error || alerts.error || 'Private records could not be loaded.');
    serverCropRecords = Array.isArray(crops.records) ? crops.records : [];
    serverReports = Array.isArray(reports.reports) ? reports.reports : [];
    serverAlerts = Array.isArray(alerts.alerts) ? alerts.alerts : [];
    databaseRecordsEnabled = true;
    persistentDataLoaded = true;
    renderCrops(); renderRequests(); renderServerAlerts();
  } catch (error) {
    databaseRecordsEnabled = false; persistentDataLoaded = false;
    const status = $('#crop-record-status'); if (status) status.textContent = `${error.message} Browser-only records remain available.`;
  }
}
async function refreshPersistentData() {
  persistentDataLoaded = false;
  if (currentUser && serviceHealth?.services?.database?.reportsEnabled) await loadPersistentData();
}
const cropForm = $("#crop-record-form");
const cropList = $("#crop-list");
let editingCropIndex = null;
let editingCropId = "";
function resetCropEdit() {
  editingCropIndex = null; editingCropId = "";
  cropForm.reset(); cropForm.querySelector('[type="submit"]').textContent = "Add crop";
}
function renderCrops() {
  const localCrops = localStore.read("crops");
  const databaseHtml = databaseRecordsEnabled ? serverCropRecords.map(crop => `<article class="record-card"><h3>${escapeHtml(crop.name)}${crop.variety ? ` \u00b7 ${escapeHtml(crop.variety)}` : ""}</h3><p>${escapeHtml(crop.area)} acres \u00b7 ${escapeHtml(crop.stage || "Stage not recorded")}</p><p>Planted: ${escapeHtml(crop.date || "Not recorded")}</p><small>Private account record</small><button class="text-link" type="button" data-edit-crop-id="${escapeHtml(crop.id)}">Edit</button><button class="text-link" type="button" data-delete-crop-id="${escapeHtml(crop.id)}">Delete</button></article>`).join("") : "";
  const localHtml = localCrops.map((crop, index) => `<article class="record-card"><h3>${escapeHtml(crop.name)}${crop.variety ? ` \u00b7 ${escapeHtml(crop.variety)}` : ""}</h3><p>${escapeHtml(crop.area)} acres \u00b7 ${escapeHtml(crop.stage || "Stage not recorded")}</p><p>Planted: ${escapeHtml(crop.date || "Not recorded")}</p><small>Saved in this browser</small><button class="text-link" type="button" data-edit-crop="${index}">Edit</button><button class="text-link" type="button" data-delete-crop="${index}">Delete</button></article>`).join("");
  cropList.innerHTML = databaseHtml + localHtml || '<p class="notification-box">No crops added yet.</p>';
}
if (cropForm) cropForm.addEventListener("submit", async event => {
  event.preventDefault(); if (!cropForm.reportValidity()) return;
  const submit = cropForm.querySelector('[type="submit"]'); submit.disabled = true;
  const values = Object.fromEntries(new FormData(cropForm));
  try {
    if (databaseRecordsEnabled && editingCropIndex === null) {
      const path = editingCropId ? `/api/crops/${encodeURIComponent(editingCropId)}` : '/api/crops';
      const response = await apiRequest(path, { method: editingCropId ? 'PUT' : 'POST', body: JSON.stringify(values) });
      if (!response.crop) throw new Error('The database did not confirm the crop record.');
      await refreshPersistentData();
      resetCropEdit(); $('#crop-record-status').textContent = 'Crop record saved to your account.';
    } else {
      const crops = localStore.read("crops");
      if (editingCropIndex === null) crops.push(values); else crops[editingCropIndex] = values;
      if (!localStore.write("crops", crops)) throw new Error('Could not save crop data in this browser. Check available site storage and try again.');
      resetCropEdit(); renderCrops(); $('#crop-record-status').textContent = 'Crop record saved in this browser only.';
    }
  } catch (error) { $('#crop-record-status').textContent = error.message; }
  finally { submit.disabled = false; }
});
if (cropList) cropList.addEventListener("click", async event => {
  const remove = event.target.closest("[data-delete-crop], [data-delete-crop-id]");
  const edit = event.target.closest("[data-edit-crop], [data-edit-crop-id]");
  if (databaseRecordsEnabled && ((remove && remove.dataset.deleteCropId) || (edit && edit.dataset.editCropId))) {
    const recordId = remove?.dataset.deleteCropId || edit?.dataset.editCropId;
    const crop = serverCropRecords.find(record => record.id === recordId);
    if (!crop || !recordId) return;
    try {
      if (remove) {
        await apiRequest(`/api/crops/${encodeURIComponent(recordId)}`, { method: "DELETE" });
        await refreshPersistentData();
        $("#crop-record-status").textContent = "Crop record deleted.";
      } else {
        for (const [key, value] of Object.entries(crop)) {
          const field = cropForm.elements.namedItem(key);
          if (field) field.value = value;
        }
        editingCropIndex = null; editingCropId = recordId;
        cropForm.querySelector('[type="submit"]').textContent = "Save changes";
        cropForm.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch (error) { $("#crop-record-status").textContent = error.message; }
    return;
  }
  const crops = localStore.read("crops");
  if (remove) {
    const index = Number(remove.dataset.deleteCrop);
    if (!Number.isInteger(index) || index < 0 || index >= crops.length) return;
    crops.splice(index, 1);
    if (!localStore.write("crops", crops)) { $("#crop-record-status").textContent = "Could not update browser storage."; return; }
    renderCrops();
  } else if (edit) {
    const index = Number(edit.dataset.editCrop);
    const crop = crops[index];
    if (!crop) return;
    for (const [key, value] of Object.entries(crop)) {
      const field = cropForm.elements.namedItem(key);
      if (field) field.value = value;
    }
    editingCropIndex = index; editingCropId = "";
    cropForm.querySelector('[type="submit"]').textContent = "Save changes";
    cropForm.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});
const expertForm = $("#expert-form");
if (expertForm) expertForm.addEventListener("submit", event => {
  event.preventDefault(); if (!expertForm.reportValidity()) return;
  const attachmentInput = expertForm.elements.namedItem("attachment");
  const attachment = attachmentInput?.files?.[0] || null;
  if (attachment && (!CONFIG.ACCEPTED_TYPES.includes(attachment.type) || attachment.size > CONFIG.MAX_IMAGE_BYTES)) {
    $("#expert-status").textContent = `Choose a JPG, PNG, or WebP image up to ${CONFIG.MAX_IMAGE_BYTES / 1024 / 1024} MB.`;
    attachmentInput.focus(); return;
  }
  const data = Object.fromEntries(new FormData(expertForm));
  delete data.attachment;
  data.attachmentName = attachment?.name || "";
  data.status = "Saved locally Ã‚Â· awaiting backend";
  data.createdAt = new Date().toISOString();
  const requests = localStore.read("requests"); requests.unshift(data);
  if (!localStore.write("requests", requests)) { $("#expert-status").textContent = "Could not save this request in browser storage. Please try again."; return; }
  expertForm.reset();
  $("#expert-status").textContent = attachment ? "Request saved in this browser. The attachment was not uploaded or stored." : "Request saved in this browser; it has not been sent to an expert.";
  renderRequests();
});
function renderRequests() {
  const target = $("#report-list");
  if (!target) return;
  const query = ($("#report-search")?.value || "").trim().toLowerCase();
  const urgency = $("#report-urgency")?.value || "";
  const rows = localStore.read("requests").map((item, index) => ({ ...item, index })).filter(item => {
    const haystack = `${item.crop} ${item.status} ${item.urgency} ${item.details}`.toLowerCase();
    return (!query || haystack.includes(query)) && (!urgency || item.urgency === urgency);
  });
  const localHtml = rows.map(item => `<article class="record-card"><h3>${escapeHtml(item.crop)} \u00b7 consultation request</h3><p>${escapeHtml(item.urgency)} \u00b7 ${escapeHtml(item.status)}</p><p>${escapeHtml(item.details)}</p>${item.attachmentName ? `<p>Attachment selected: ${escapeHtml(item.attachmentName)} (not uploaded)</p>` : ""}<small>${new Date(item.createdAt).toLocaleString()} \u00b7 saved in this browser</small><div class="report-actions"><button class="button button-dark" type="button" data-download-request="${item.index}">Download JSON</button><button class="button button-outline" type="button" data-share-request="${item.index}">Share</button></div></article>`);
  const reportItems = databaseRecordsEnabled && !urgency ? serverReports.filter(item => `${item.crop} ${item.identifiedCrop || ""} ${item.disease} ${item.symptoms?.join(" ") || ""}`.toLowerCase().includes(query)) : [];
  const databaseHtml = reportItems.map(item => `<article class="record-card"><h3>${escapeHtml(item.crop)} \u00b7 crop analysis</h3>${item.identifiedCrop ? `<small>Visible crop estimate: ${escapeHtml(item.identifiedCrop)}</small>` : ""}<p>${escapeHtml(item.uncertain ? "Uncertain assessment" : item.disease || "Assessment received")}${item.severity && item.severity !== "unknown" ? ` \u00b7 ${escapeHtml(item.severity)} severity` : ""}</p>${item.uncertaintyMessage ? `<p>${escapeHtml(item.uncertaintyMessage)}</p>` : ""}${item.symptoms?.length ? `<p>${item.symptoms.map(escapeHtml).join(" \u00b7 ")}</p>` : ""}<small>${new Date(item.createdAt).toLocaleString()} \u00b7 private account report; photo not stored</small><div class="report-actions"><button class="button button-dark" type="button" data-download-report="${escapeHtml(item.id)}">Download JSON</button><button class="button button-outline" type="button" data-share-report="${escapeHtml(item.id)}">Share</button><button class="button button-outline" type="button" data-delete-report="${escapeHtml(item.id)}">Delete</button></div></article>`);
  target.innerHTML = [...databaseHtml, ...localHtml].join("") || '<p class="notification-box">No matching requests or saved crop assessments.</p>';
}
function renderServerAlerts() {
  const target = $("#notification-list");
  if (!target || !databaseRecordsEnabled) return;
  if (!serverAlerts.length) { target.innerHTML = '<p>No verified alerts are stored for your account.</p>'; return; }
  target.innerHTML = serverAlerts.map(alert => `<article class="notification-item"><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.message)}</p><small>${escapeHtml(alert.source)} \u00b7 ${new Date(alert.createdAt).toLocaleString()}</small></article>`).join("");
}
$("#report-search")?.addEventListener("input", renderRequests);
$("#report-urgency")?.addEventListener("change", renderRequests);
$("#print-reports")?.addEventListener("click", () => window.print());
$("#report-list")?.addEventListener("click", async event => {
  const target = event.target.closest("[data-download-report], [data-share-report], [data-delete-report], [data-download-request], [data-share-request]");
  if (!target) return;
  const reportId = target.dataset.downloadReport || target.dataset.shareReport || target.dataset.deleteReport;
  if (reportId) {
    const report = serverReports.find(item => item.id === reportId);
    if (!report) return;
    if (target.hasAttribute("data-delete-report")) {
      try {
        await apiRequest(`/api/reports/${encodeURIComponent(report.id)}`, { method: "DELETE" });
        serverReports = serverReports.filter(item => item.id !== report.id);
        renderRequests();
        $("#report-status").textContent = "Report deleted from MongoDB.";
      } catch (error) { $("#report-status").textContent = error.message; }
      return;
    }
    const summary = { crop: report.crop, identifiedCrop: report.identifiedCrop, affectedPart: report.affectedPart, growthStage: report.growthStage, location: report.location, possibleProblem: report.disease, uncertain: report.uncertain, uncertaintyMessage: report.uncertaintyMessage, severity: report.severity, confidenceLevel: report.confidenceLevel, confidenceNote: report.confidenceNote, symptoms: report.symptoms, possibleCauses: report.possibleCauses, recommendations: report.recommendations, prevention: report.prevention, expertWhen: report.expertWhen, createdAt: report.createdAt };
    if (target.hasAttribute("data-download-report")) {
      const blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `krishimonitor-report-${report.id}.json`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    const text = `${summary.crop} crop assessment\n${summary.possibleProblem || "Uncertain assessment"}\n${(summary.symptoms || []).join("; ")}\nSaved ${new Date(summary.createdAt).toLocaleString()}`;
    try {
      if (navigator.share) await navigator.share({ title: "KrishiMonitor crop report", text });
      else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); window.alert("Report summary copied to clipboard."); }
      else window.alert(text);
    } catch (error) { if (error.name !== "AbortError") window.alert("Could not share this report from the current browser."); }
    return;
  }
  const requestIndex = Number(target.dataset.downloadRequest ?? target.dataset.shareRequest);
  if (!Number.isInteger(requestIndex) || requestIndex < 0) return;
  const item = localStore.read("requests")[requestIndex];
  if (!item) return;
  const summary = { crop: item.crop, urgency: item.urgency, description: item.details, status: item.status, createdAt: item.createdAt, attachmentName: item.attachmentName || null };
  if (target.hasAttribute("data-download-request")) {
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `krishimonitor-request-${requestIndex + 1}.json`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const text = `${summary.crop} consultation request \u00b7 ${summary.urgency}\n${summary.description}\nStatus: ${summary.status}`;
  try {
    if (navigator.share) await navigator.share({ title: "KrishiMonitor consultation request", text });
    else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); window.alert("Request summary copied to clipboard."); }
    else window.alert(text);
  } catch (error) { if (error.name !== "AbortError") window.alert("Could not share this request from the current browser."); }
});
renderRequests();

const checklistButton = $("#save-checklist");
const checklistStatus = document.createElement("span"); checklistStatus.setAttribute("role", "status"); checklistButton.insertAdjacentElement("afterend", checklistStatus);
checklistButton.addEventListener("click", () => {
  const selected = Object.fromEntries($$("[data-check]").map(item => [item.dataset.check, item.checked]));
  checklistStatus.textContent = localStore.write("checklist", selected) ? "Checklist saved in this browser." : "Could not save the checklist in browser storage.";
});
const savedChecks = localStore.read("checklist", {}); $$('[data-check]').forEach(item => { item.checked = Boolean(savedChecks[item.dataset.check]); const label = item.closest("label"); label.classList.toggle("is-checked", item.checked); item.addEventListener("change", () => label.classList.toggle("is-checked", item.checked)); });
$("#mark-read")?.addEventListener("click", event => {
  const unread = $$(".notification-item:not(.is-read)", $("#notification-list"));
  if (!unread.length) { event.currentTarget.textContent = "No unread alerts"; event.currentTarget.disabled = true; return; }
  unread.forEach(item => item.classList.add("is-read"));
  event.currentTarget.textContent = "All read";
  event.currentTarget.disabled = true;
});
$$('[data-plan]').forEach(button => button.addEventListener("click", () => window.alert(`${button.dataset.plan} is a demo selection only. No payment has been taken.`)));
const languageButton = $("#lang-toggle");
const translations = { "Home":"\u092e\u0941\u0916\u092a\u0943\u0937\u094d\u0920", "Dashboard":"\u0921\u0948\u0936\u092c\u094b\u0930\u094d\u0921", "My Crops":"\u092e\u0947\u0930\u0940 \u092b\u0938\u0932\u0947\u0902", "AI Detection":"\u090f\u0906\u0908 \u092a\u0939\u091a\u093e\u0928", "Weather":"\u092e\u094c\u0938\u092e", "Risk Monitor":"\u091c\u094b\u0916\u093f\u092e \u0928\u093f\u0917\u0930\u093e\u0928\u0940", "IPM Advisory":"\u0906\u0908\u092a\u0940\u090f\u092e \u0938\u0932\u093e\u0939", "Reports":"\u0930\u093f\u092a\u094b\u0930\u094d\u091f", "MY CROPS":"\u092e\u0947\u0930\u0940 \u092b\u0938\u0932\u0947\u0902", "Add crop":"\u092b\u0938\u0932 \u091c\u094b\u0921\u093c\u0947\u0902", "EXPERT CONSULTATION":"\u0935\u093f\u0936\u0947\u0937\u091c\u094d\u091e \u092a\u0930\u093e\u092e\u0930\u094d\u0936", "Save request":"\u0905\u0928\u0941\u0930\u094b\u0927 \u0938\u0947\u0935 \u0915\u0930\u0947\u0902", "REPORTS & HISTORY":"\u0930\u093f\u092a\u094b\u0930\u094d\u091f \u0914\u0930 \u0907\u0924\u093f\u0939\u093e\u0938", "NOTIFICATIONS":"\u0938\u0942\u091a\u0928\u093e\u090f\u0902", "Mark all read":"\u0938\u092d\u0940 \u092a\u0922\u093c\u0947 \u0939\u0941\u090f", "Select demo plan":"\u0921\u0947\u092e\u094b \u092f\u094b\u091c\u0928\u093e \u091a\u0941\u0928\u0947\u0902" };
function setLanguage(language) {
  document.documentElement.lang = language;
  $$('a,button,.eyebrow').forEach(el => {
    // Keep nested brand styling, icons, and arrow spans intact.
    if (el.children.length) return;
    if (!el.dataset.originalText) el.dataset.originalText = el.textContent.trim();
    const base = el.dataset.originalText;
    el.textContent = language === "hi" ? (translations[base] || base) : base;
  });
  languageButton.textContent = language === "hi" ? "English" : "\u0939\u093f\u0902\u0926\u0940";
  try { localStorage.setItem("km_language", language); } catch { /* Keep the selected language for this page view. */ }
}
if (languageButton) {
  languageButton.addEventListener("click", () => setLanguage(document.documentElement.lang === "hi" ? "en" : "hi"));
  let savedLanguage = "en";
  try { savedLanguage = localStorage.getItem("km_language") || "en"; } catch { /* Storage may be disabled in private browsing. */ }
  setLanguage(savedLanguage);
}



$("#language-setting")?.addEventListener("click", () => languageButton?.click());

// Keep the navigation state in sync with the section currently in view.
const navigableLinks = $$('.nav-links a[href^="#"], .mobile-bar a[href^="#"]');
const sectionTargets = [...new Set(navigableLinks.map(link => document.querySelector(link.getAttribute("href"))).filter(Boolean))];
if ("IntersectionObserver" in window) {
  const activeSections = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      navigableLinks.forEach(link => link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`));
    });
  }, { rootMargin: "-25% 0px -65% 0px", threshold: 0 });
  sectionTargets.forEach(section => activeSections.observe(section));
}


// Scroll reveals, sample counter motion, and enhancement for dynamically rendered cards.
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const motionTargets = $$('main > section:not(.hero), .feature, .metric-card, .panel, .upload-card, .weather-card, .weather-state, .health-ring, .record-card, .plan-card, .pest-inner, .about');
const countedMetrics = new WeakSet();
function animateMetric(metric) {
  if (prefersReducedMotion || countedMetrics.has(metric)) return;
  const original = metric.textContent.trim();
  if (!/^\d+$/.test(original)) return;
  const target = Number(original), pad = original.length > 1 && original.startsWith("0");
  countedMetrics.add(metric);
  const startAt = performance.now(), duration = 850;
  const tick = now => {
    const progress = Math.min(1, (now - startAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(target * eased);
    metric.textContent = pad ? String(value).padStart(original.length, "0") : String(value);
    if (progress < 1) requestAnimationFrame(tick);
    else metric.textContent = original;
  };
  requestAnimationFrame(tick);
}
let revealObserver = null;
const revealedMotion = new WeakSet();
function showMotionElement(element) {
  if (revealedMotion.has(element)) return;
  revealedMotion.add(element);
  element.classList.add("is-visible");
  if (element.matches(".metric-card")) animateMetric($("strong", element));
  if (element.matches(".health-ring")) element.classList.add("is-animated");
  revealObserver?.unobserve(element);
}
function revealVisibleMotionElements() {
  const revealLine = window.innerHeight - 20;
  motionTargets.forEach(element => {
    if (revealedMotion.has(element)) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom > 0 && bounds.top < revealLine) showMotionElement(element);
  });
}
function registerReveal(element, index = 0) {
  if (!(element instanceof Element) || element.classList.contains("scroll-reveal")) return;
  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    element.classList.add("is-visible");
    return;
  }
  if (element.matches(".health-ring")) element.style.setProperty("--health-sweep", "0deg");
  element.classList.add("scroll-reveal");
  const delay = index % 4;
  if (delay) element.dataset.revealDelay = String(delay);
  revealObserver.observe(element);
}
if (prefersReducedMotion || !("IntersectionObserver" in window)) {
  motionTargets.forEach((element, index) => registerReveal(element, index));
} else {
  revealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      showMotionElement(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -35px 0px" });
  motionTargets.forEach((element, index) => registerReveal(element, index));
  let revealFrame = 0;
  const checkVisibleMotion = () => {
    if (revealFrame) return;
    revealFrame = requestAnimationFrame(() => { revealVisibleMotionElements(); revealFrame = 0; });
  };
  window.addEventListener("scroll", checkVisibleMotion, { passive: true });
  window.addEventListener("resize", checkVisibleMotion, { passive: true });
  requestAnimationFrame(checkVisibleMotion);
  window.setTimeout(checkVisibleMotion, 650);

  const dynamicCardObserver = new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return;
      if (node.matches(".record-card")) registerReveal(node);
      node.querySelectorAll(".record-card").forEach(card => registerReveal(card));
    }));
  });
  [$("#crop-list"), $("#report-list")].filter(Boolean).forEach(list => dynamicCardObserver.observe(list, { childList: true }));
}












