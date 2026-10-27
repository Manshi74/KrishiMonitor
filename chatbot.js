const $ = (selector, root = document) => root.querySelector(selector);
const panel = $("#farm-chat-panel");
const launch = $("#farm-chat-launch");
const messageList = $("#farm-chat-messages");
const form = $("#farm-chat-form");
const input = $("#farm-chat-input");
const galleryInput = $("#farm-chat-gallery");
const cameraInput = $("#farm-chat-camera");
const consent = $("#farm-chat-consent");
const consentCheck = $("#farm-chat-consent-check");
const imagePreview = $("#farm-chat-image-preview");
const previewImage = $("#farm-chat-image");
const errorBox = $("#farm-chat-error");
let MAX_IMAGE_BYTES = 10 * 1024 * 1024;
let MAX_REQUEST_BYTES = 12 * 1024 * 1024;
let MAX_PROMPT_CHARS = 2000;
let MIN_IMAGE_DIMENSION = 256;
let MAX_IMAGE_DIMENSION = 4096;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
let photoSelectionToken = 0;
let pendingFile = null;
let pendingObjectUrl = "";
let lastImageFile = null;
let lastImageObjectUrl = "";
let sessionObjectUrls = [];
let history = [];
let busy = false;
let controller = null;
let generation = 0;
let retryDraft = null;

function setError(text = "") {
  errorBox.textContent = text;
  errorBox.hidden = !text;
}
function scrollChat() { messageList.scrollTop = messageList.scrollHeight; }
function addMessage(role, text, imageUrl = "", extraClass = "") {
  const article = document.createElement("article");
  article.className = `farm-chat-message ${role === "user" ? "user-message" : "assistant-message"} ${extraClass}`.trim();
  if (role !== "user") {
    const avatar = document.createElement("span"); avatar.className = "message-avatar"; avatar.setAttribute("aria-hidden", "true"); avatar.textContent = "✳"; article.append(avatar);
  }
  const bubble = document.createElement("div"); bubble.className = "message-bubble";
  if (imageUrl) { const image = document.createElement("img"); image.src = imageUrl; image.alt = "Crop photo sent in this chat"; bubble.append(image); }
  if (text) bubble.append(document.createTextNode(text));
  article.append(bubble); messageList.append(article); scrollChat();
}
function addErrorMessage(text, language) {
  addMessage("assistant", text, "", "chat-error-message");
  const article = messageList.lastElementChild;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "farm-chat-retry";
  retry.textContent = language === "hi" ? "फिर से कोशिश करें" : "Retry";
  article.querySelector(".message-bubble").append(retry);
}
const CHAT_API_BASE = String(window.KRISHI_CHAT_API_BASE || "").replace(/\/+$/, "");
function chatApiUrl(path) { return `${CHAT_API_BASE}${path}`; }
function formatStructuredAnswer(data, language) {
  const isHindi = language === "hi";
  const lines = [data.reply.trim()];
  const addList = (label, values) => { if (Array.isArray(values) && values.some(value => typeof value === "string" && value.trim())) lines.push(`${label}:\n${values.filter(value => typeof value === "string" && value.trim()).map(value => `• ${value.trim()}`).join("\n")}`); };
  if (data.uncertain === true) lines.push(isHindi ? "तस्वीर से समस्या की पक्की पहचान नहीं हो सकी। कृषि विशेषज्ञ से पुष्टि करें।" : "I couldn’t identify the problem reliably from this photo. Please ask an agricultural expert to confirm.");
  if (typeof data.possibleDiagnosis === "string" && data.possibleDiagnosis.trim()) lines.push(`${isHindi ? "संभावित समस्या" : "Possible problem"}: ${data.possibleDiagnosis.trim()}`);
  addList(isHindi ? "दिखने वाले लक्षण" : "Visible symptoms", data.symptoms);
  addList(isHindi ? "संभावित कारण" : "Possible causes", data.possibleCauses);
  addList(isHindi ? "बचाव" : "Prevention", data.preventiveMeasures);
  addList(isHindi ? "अगले कदम" : "Recommended next steps", data.recommendations);
  if (data.needsExpert === true && data.uncertain !== true) lines.push(isHindi ? "कृषि विशेषज्ञ से जाँच कराएँ।" : "Please have an agricultural expert verify this.");
  return lines.filter(Boolean).join("\n\n");
}
function detectImageMimeType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}
async function readImageDimensions(file, objectUrl) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try { return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close?.(); }
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("invalid"));
    image.src = objectUrl;
  });
}
function updateUploadLimits(limits) {
  if (!limits || typeof limits !== "object") return;
  const setLimit = (key, minimum, maximum, apply) => {
    const value = Number(limits[key]);
    if (Number.isFinite(value) && value >= minimum && value <= maximum) apply(value);
  };
  setLimit("maxImageBytes", 1, 10 * 1024 * 1024, value => { MAX_IMAGE_BYTES = value; });
  setLimit("maxRequestBytes", 1, 12 * 1024 * 1024, value => { MAX_REQUEST_BYTES = value; });
  setLimit("maxPromptChars", 1, 2000, value => { MAX_PROMPT_CHARS = value; input.maxLength = String(value); });
  setLimit("minImageDimension", 256, 4096, value => { MIN_IMAGE_DIMENSION = value; });
  setLimit("maxImageDimension", 256, 4096, value => { MAX_IMAGE_DIMENSION = value; });
  $("#farm-chat-upload-guidance").textContent = `One JPG, PNG, or WEBP image \u00b7 up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB \u00b7 ${MIN_IMAGE_DIMENSION} \u00d7 ${MIN_IMAGE_DIMENSION} to ${MAX_IMAGE_DIMENSION} \u00d7 ${MAX_IMAGE_DIMENSION} px. 1024 px or larger is recommended.`;
}
async function selectPhoto(file) {
  if (!file) return;
  const selection = ++photoSelectionToken;
  setError();
  if (pendingFile) consentCheck.checked = false;
  if (!file.size) { setError("This image could not be processed. Please upload another photo."); return; }
  if (file.size > MAX_IMAGE_BYTES) { setError(`Image must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.`); return; }
  let objectUrl = "";
  try {
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(detectImageMimeType(header))) { setError("Please upload a JPG, PNG, or WEBP image."); return; }
    objectUrl = URL.createObjectURL(file);
    const { width, height } = await readImageDimensions(file, objectUrl);
    if (selection !== photoSelectionToken) { URL.revokeObjectURL(objectUrl); return; }
    if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      URL.revokeObjectURL(objectUrl);
      setError(`Image dimensions must be between ${MIN_IMAGE_DIMENSION} \u00d7 ${MIN_IMAGE_DIMENSION} and ${MAX_IMAGE_DIMENSION} \u00d7 ${MAX_IMAGE_DIMENSION} pixels.`);
      return;
    }
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (selection === photoSelectionToken) setError("This image could not be processed. Please upload another photo.");
    return;
  }
  if (selection !== photoSelectionToken) { if (objectUrl) URL.revokeObjectURL(objectUrl); return; }
  if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
  pendingFile = file;
  pendingObjectUrl = objectUrl;
  previewImage.src = pendingObjectUrl;
  $("#farm-chat-filename").textContent = `${file.name} \u00b7 ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  imagePreview.hidden = false;
  consent.hidden = false;
  consentCheck.checked = false;
  input.focus();
}
function removePendingPhoto() {
  photoSelectionToken += 1;
  if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl);
  pendingFile = null; pendingObjectUrl = "";
  previewImage.removeAttribute("src"); imagePreview.hidden = true;
  consent.hidden = true; consentCheck.checked = false;
  galleryInput.value = ""; cameraInput.value = "";
}
function setBusy(value) {
  busy = value;
  $("#farm-chat-send").disabled = value;
  $("#farm-chat-typing").hidden = !value;
  input.disabled = value;
  if (!value) input.focus();
  scrollChat();
}
async function checkService() {
  const label = $("#farm-chat-service");
  try {
    const response = await fetch(chatApiUrl("/api/chat/health"), { headers: { Accept: "application/json" }, cache: "no-store" });
    const status = await response.json();
    updateUploadLimits(status.limits);
    label.textContent = status.configured ? "Gemini configured" : "Gemini setup needed";
    label.parentElement.classList.toggle("service-ready", Boolean(status.configured));
  } catch {
    updateUploadLimits({});
    label.textContent = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
      ? "Start the KrishiMonitor server"
      : "AI backend unavailable";
    label.parentElement.classList.remove("service-ready");
  }
}
function openChat() {
  panel.hidden = false;
  launch.setAttribute("aria-expanded", "true");
  launch.setAttribute("aria-label", "Close KrishiMonitor farm assistant");
  checkService();
  input.focus();
}
window.krishiChat = window.krishiChat || {};
window.krishiChat.openWithAnalysis = ({ summary, language } = {}) => {
  if (typeof summary !== "string" || !summary.trim()) return;
  const lang = language === "en" ? "en" : "hi";
  const context = "Farmer's latest preliminary crop-photo assessment (text only; no photo is included): " + summary.slice(0, 5000);
  history = [
    { role: "user", content: context },
    { role: "assistant", content: lang === "hi" ? "मैं इस प्रारंभिक आकलन को संदर्भ के रूप में रखूँगा। यह पक्की पहचान नहीं है।" : "I will use this preliminary assessment as context. It is not a confirmed diagnosis." }
  ];
  chatLanguage.value = lang;
  openChat();
  input.value = lang === "hi" ? "इस फसल रिपोर्ट के आधार पर मुझे आगे क्या जाँचना चाहिए?" : "Based on this crop report, what should I check next?";
  input.focus();
};
function closeChat() {
  panel.hidden = true;
  launch.setAttribute("aria-expanded", "false");
  launch.setAttribute("aria-label", "Open KrishiMonitor farm assistant");
  launch.focus();
}
launch.addEventListener("click", () => panel.hidden ? openChat() : closeChat());
messageList.addEventListener("click", event => {
  const retry = event.target.closest(".farm-chat-retry");
  if (!retry || !retryDraft || busy) return;
  const draft = retryDraft;
  retryDraft = null;
  const errorMessage = retry.closest(".farm-chat-message");
  const failedUserMessage = errorMessage?.previousElementSibling;
  errorMessage?.remove();
  if (failedUserMessage?.classList.contains("user-message")) failedUserMessage.remove();
  input.value = draft.message;
  chatLanguage.value = draft.language;
  form.requestSubmit();
});
$("#farm-chat-close").addEventListener("click", closeChat);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !panel.hidden) closeChat();
});

for (const source of [galleryInput, cameraInput]) source.addEventListener("change", () => {
  const files = Array.from(source.files || []);
  source.value = "";
  if (files.length > 1) { photoSelectionToken += 1; consentCheck.checked = false; setError("Please upload one crop image at a time."); return; }
  if (files[0]) selectPhoto(files[0]);
});
$("#farm-chat-remove-image").addEventListener("click", removePendingPhoto);
$("#farm-chat-suggestions").addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  input.value = button.textContent.trim();
  form.requestSubmit();
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
});
input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
});

$("#farm-chat-clear").addEventListener("click", () => {
  generation += 1;
  controller?.abort(); controller = null;
  setBusy(false);
  sessionObjectUrls.forEach(URL.revokeObjectURL);
  sessionObjectUrls = [];
  removePendingPhoto();
  lastImageFile = null; lastImageObjectUrl = ""; history = [];
  retryDraft = null;
  messageList.replaceChildren();
  addMessage("assistant", "Namaste! I can help with crop care, pests, irrigation, and plant photos. What’s happening in your field?\nनमस्ते! फसल की देखभाल, कीट, सिंचाई और पौधों की तस्वीर के बारे में पूछें।");
  $("#farm-chat-suggestions").hidden = false;
  setError();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const question = input.value.trim();
  if (!question && !pendingFile) { input.focus(); return; }
  if (question.length > MAX_PROMPT_CHARS) { setError(`Message must be ${MAX_PROMPT_CHARS} characters or fewer.`); input.focus(); return; }
  if (pendingFile && !consentCheck.checked) { setError("Please agree before sending this photo to Google Gemini. / तस्वीर भेजने से पहले सहमति दें।"); consentCheck.focus(); return; }
  retryDraft = null;
  setError();
  const thisGeneration = generation;
  setBusy(true);
  const userText = question || "Please inspect this crop photo. Describe visible symptoms and what I should check next.";
  try {
    let visiblePhoto = "";
    if (pendingFile) {
      lastImageFile = pendingFile;
      const objectUrlToSend = pendingObjectUrl;
      if (thisGeneration !== generation) return;
      lastImageObjectUrl = objectUrlToSend;
      visiblePhoto = lastImageObjectUrl;
      sessionObjectUrls.push(objectUrlToSend);
      pendingObjectUrl = ""; pendingFile = null;
      previewImage.removeAttribute("src"); imagePreview.hidden = true;
      consent.hidden = true; consentCheck.checked = false;
      galleryInput.value = ""; cameraInput.value = "";
    }
    if (thisGeneration !== generation) return;
    addMessage("user", userText, visiblePhoto);
    $("#farm-chat-suggestions").hidden = true;
    input.value = ""; input.style.height = "auto";
    const nextHistory = [...history, { role: "user", content: userText }].slice(-12);
    if (nextHistory[0]?.role === "assistant") nextHistory.shift();
    const payload = new FormData();
    payload.append("message", userText);
    payload.append("language", $("#farm-chat-language").value);
    payload.append("conversationHistory", JSON.stringify(nextHistory));
    if (lastImageFile) {
      payload.append("image", lastImageFile, "crop-photo");
      payload.append("photoConsent", "true");
    }
    const formTextBytes = new Blob([userText, JSON.stringify(nextHistory), "language", "photoConsent", "true"]).size;
    if ((lastImageFile?.size || 0) + formTextBytes + 2048 > MAX_REQUEST_BYTES) throw new Error(`Request body must be ${MAX_REQUEST_BYTES / 1024 / 1024} MB or smaller.`);
    controller = new AbortController();
    const response = await fetch(chatApiUrl("/api/chat"), {
      method: "POST", headers: { Accept: "application/json" }, body: payload, signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `Chat service returned ${response.status}.`);
    if (typeof data.reply !== "string" || !data.reply.trim()) throw new Error("The AI service returned an empty reply.");
    if (thisGeneration !== generation) return;
    const structuredReply = formatStructuredAnswer(data, $("#farm-chat-language").value);
    history = [...nextHistory, { role: "assistant", content: structuredReply }].slice(-12);
    addMessage("assistant", structuredReply);
  } catch (error) {
    if (error.name === "AbortError" || thisGeneration !== generation) return;
    retryDraft = { message: userText, language: chatLanguage.value };
    addErrorMessage(error.message || "The assistant could not respond. Please try again.", retryDraft.language);
  } finally {
    if (thisGeneration === generation) { controller = null; setBusy(false); }
  }
});

const chatLanguage = $("#farm-chat-language");
chatLanguage.value = document.documentElement.lang === "hi" ? "hi" : "en";
const mainLanguageToggle = $("#lang-toggle");
mainLanguageToggle?.addEventListener("click", () => { chatLanguage.value = document.documentElement.lang === "hi" ? "hi" : "en"; });

// Open the assistant on page load so visitors can start asking about their crops right away.
openChat();
