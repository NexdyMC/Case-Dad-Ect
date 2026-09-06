/* ===================================================================
   DATA DETECTIVE / OSINT CHALLENGE — application logic
   Sections:
   1. Constants & state
   2. Storage helpers (API key, model, settings, progress)
   3. Screen router (transitions) & bottom nav
   4. Settings screen (font, accent color, question font size, danger zone)
   5. Case board (Arsip Kasus) — render + done-state validation
   6. Play screen (timer, form)
   7. Submission -> Groq API -> verdict -> "Selesai" -> Finish screen
   8. Finish screen renderer (used for fresh result AND read-only recap)
   9. Utilities
=================================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------------
     1. CONSTANTS & STATE
  --------------------------------------------------------------- */
  const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
  const DEFAULT_MODEL = "llama-3.3-70b-versatile";

  const LS_KEYS = {
    apiKey: "dataDetective_groqApiKey",
    model: "dataDetective_groqModel",
    settings: "dataDetective_settings",
    progress: "dataDetective_progress",
  };

  const DEFAULT_SETTINGS = {
    font: "sans",
    accentColor: "#10b981",
    questionFontSize: 18,
  };

  const FONT_STACKS = {
    sans: "'Inter', sans-serif",
    serif: "'Lora', serif",
    mono: "'JetBrains Mono', monospace",
    rounded: "'Quicksand', sans-serif",
  };

  const state = {
    cases: [],
    activeCase: null,
    timerInterval: null,
    remainingSeconds: 0,
    isLocked: false,
    isSubmitting: false,
    currentScreen: "beranda",
    lastVerdict: null, // holds { skor, status, penjelasan, point } after AI responds, before "Selesai" is pressed
  };

  const $ = window.jQuery;

  /* ---------------------------------------------------------------
     INIT
  --------------------------------------------------------------- */
  $(document).ready(function () {
    AOS.init({ duration: 500, easing: "ease-out-cubic", once: true, offset: 30 });

    applySettings(getSettings());
    initApiStatus();
    initNav();
    initSettingsScreen();
    bindGlobalEvents();
    loadCases();
  });

  function bindGlobalEvents() {
    $("#goToArsipBtn").on("click", () => switchScreen("arsip"));
    $("#backToArsipBtn").on("click", closePlayScreen);
    $("#submissionForm").on("submit", handleSubmit);
    $("#finishToArsipBtn").on("click", () => switchScreen("arsip"));
    $("#finishToHomeBtn").on("click", () => switchScreen("beranda"));
    $("#apiStatusBtn").on("click", () => switchScreen("setting"));
  }

  /* ---------------------------------------------------------------
     2. STORAGE HELPERS
  --------------------------------------------------------------- */
  function getApiKey() { return localStorage.getItem(LS_KEYS.apiKey) || ""; }
  function setApiKey(key) {
    if (key) localStorage.setItem(LS_KEYS.apiKey, key);
    else localStorage.removeItem(LS_KEYS.apiKey);
  }

  function getModel() { return localStorage.getItem(LS_KEYS.model) || DEFAULT_MODEL; }
  function setModel(model) { localStorage.setItem(LS_KEYS.model, model || DEFAULT_MODEL); }

  function getSettings() {
    try {
      const raw = localStorage.getItem(LS_KEYS.settings);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings(settings) {
    localStorage.setItem(LS_KEYS.settings, JSON.stringify(settings));
  }

  function getProgress() {
    try {
      const raw = localStorage.getItem(LS_KEYS.progress);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveProgressForCase(caseId, entry) {
    const progress = getProgress();
    progress[caseId] = entry;
    localStorage.setItem(LS_KEYS.progress, JSON.stringify(progress));
    return progress;
  }
  function isCaseCompleted(caseId) {
    const progress = getProgress();
    return !!progress[caseId];
  }
  function getCaseProgress(caseId) {
    const progress = getProgress();
    return progress[caseId] || null;
  }

  function clearAllAppData() {
    Object.values(LS_KEYS).forEach((key) => localStorage.removeItem(key));
  }

  /* ---------------------------------------------------------------
     3. SCREEN ROUTER & BOTTOM NAV
  --------------------------------------------------------------- */
  function switchScreen(target) {
    const current = document.querySelector(".screen.is-active");
    const next = document.getElementById("screen-" + target);
    if (!next || current === next) return;

    if (current) current.classList.remove("is-active");
    requestAnimationFrame(() => next.classList.add("is-active"));

    state.currentScreen = target;
    updateNavActiveState(target);

    const viewport = document.querySelector(".screens-viewport");
    if (next) next.scrollTop = 0;

    if (target === "beranda") refreshBerandaStats();
    if (target === "arsip") renderCaseGrid(state.cases);
  }

  function updateNavActiveState(target) {
    // Play & Finish are sub-flows of Arsip Kasus, so highlight "arsip" while inside them.
    const navTarget = target === "play" || target === "finish" ? "arsip" : target;
    $(".nav-btn").removeClass("is-active");
    $(`.nav-btn[data-nav="${navTarget}"]`).addClass("is-active");
  }

  function initNav() {
    $(".nav-btn").on("click", function () {
      const target = $(this).data("nav");
      // Leaving an in-progress Play session via nav should stop its timer.
      if (state.currentScreen === "play" && target !== "arsip") stopTimer();
      switchScreen(target);
    });
    updateNavActiveState("beranda");
  }

  /* ---------------------------------------------------------------
     4. SETTINGS SCREEN
  --------------------------------------------------------------- */
  function hexToRgbString(hex) {
    const clean = hex.replace("#", "");
    const bigint = parseInt(clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `${r}, ${g}, ${b}`;
  }

  function applySettings(settings) {
    const root = document.documentElement;
    root.style.setProperty("--font-body", FONT_STACKS[settings.font] || FONT_STACKS.sans);
    root.style.setProperty("--accent", settings.accentColor);
    root.style.setProperty("--accent-rgb", hexToRgbString(settings.accentColor));
    root.style.setProperty("--question-font-size", settings.questionFontSize + "px");
  }

  function reflectSettingsInUI(settings) {
    $(".font-choice-btn").removeClass("is-selected");
    $(`.font-choice-btn[data-font="${settings.font}"]`).addClass("is-selected");

    $("#accentColorInput").val(settings.accentColor);
    $(".swatch-preset").removeClass("is-selected");
    $(`.swatch-preset[data-color="${settings.accentColor}"]`).addClass("is-selected");

    $("#questionFontSizeInput").val(settings.questionFontSize);
    $("#questionFontSizeValue").text(settings.questionFontSize);
  }

  function initSettingsScreen() {
    const settings = getSettings();
    reflectSettingsInUI(settings);

    $("#settingsApiKeyInput").val(getApiKey());
    $("#settingsModelInput").val(getModel());

    $(".font-choice-btn").on("click", function () {
      const font = $(this).data("font");
      const s = getSettings();
      s.font = font;
      saveSettings(s);
      applySettings(s);
      reflectSettingsInUI(s);
    });

    $("#accentColorInput").on("input", function () {
      const color = $(this).val();
      const s = getSettings();
      s.accentColor = color;
      saveSettings(s);
      applySettings(s);
      reflectSettingsInUI(s);
    });

    $(".swatch-preset").on("click", function () {
      const color = $(this).data("color");
      const s = getSettings();
      s.accentColor = color;
      saveSettings(s);
      applySettings(s);
      reflectSettingsInUI(s);
    });

    $("#questionFontSizeInput").on("input", function () {
      const size = parseInt($(this).val(), 10);
      $("#questionFontSizeValue").text(size);
      const s = getSettings();
      s.questionFontSize = size;
      saveSettings(s);
      applySettings(s);
    });

    $("#toggleApiKeyVisibility").on("click", function () {
      const $input = $("#settingsApiKeyInput");
      const isPassword = $input.attr("type") === "password";
      $input.attr("type", isPassword ? "text" : "password");
      $(this).find("i").toggleClass("fa-eye fa-eye-slash");
    });

    $("#saveApiSettingsBtn").on("click", function () {
      const key = $("#settingsApiKeyInput").val().trim();
      const model = $("#settingsModelInput").val().trim();
      setApiKey(key);
      setModel(model || DEFAULT_MODEL);
      $("#settingsModelInput").val(getModel());
      initApiStatus();
      $("#apiSettingsSavedNote").removeClass("hidden");
      setTimeout(() => $("#apiSettingsSavedNote").addClass("hidden"), 2500);
    });

    $("#deleteAllDataBtn").on("click", function () {
      openConfirmModal({
        title: "Hapus Seluruh Data?",
        body: "Semua progres kasus, poin, pengaturan tampilan, dan API key akan dihapus permanen dari perangkat ini.",
        onConfirm: function () {
          clearAllAppData();
          applySettings(DEFAULT_SETTINGS);
          reflectSettingsInUI(DEFAULT_SETTINGS);
          $("#settingsApiKeyInput").val("");
          $("#settingsModelInput").val(DEFAULT_MODEL);
          initApiStatus();
          renderCaseGrid(state.cases);
          refreshBerandaStats();
          switchScreen("beranda");
        },
      });
    });
  }

  function openConfirmModal({ title, body, onConfirm }) {
    $("#confirmModalTitle").text(title);
    $("#confirmModalBody").text(body);
    const modalEl = document.getElementById("confirmModal");
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

    const $btn = $("#confirmModalActionBtn");
    $btn.off("click").on("click", function () {
      onConfirm();
      modal.hide();
    });
    modal.show();
  }

  function initApiStatus() {
    const hasKey = !!getApiKey();
    if (hasKey) {
      $("#apiStatusDot").css("color", "var(--accent)");
      $("#apiStatusText").text("API terhubung");
      $("#apiStatusBtn").addClass("border-accent").removeClass("text-slate-500");
    } else {
      $("#apiStatusDot").css("color", "");
      $("#apiStatusText").text("API belum terhubung");
      $("#apiStatusBtn").removeClass("border-accent").addClass("text-slate-500");
    }
  }

  /* ---------------------------------------------------------------
     5. CASE BOARD (ARSIP KASUS)
  --------------------------------------------------------------- */
  function loadCases() {
    $.getJSON("soal.json")
      .done(function (data) {
        state.cases = data || [];
        renderCaseGrid(state.cases);
        refreshBerandaStats();
        $("#statTotalCases").text(state.cases.length);
      })
      .fail(function () {
        $("#caseGrid").html(
          `<div class="col-span-full rounded-lg border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-300 font-mono-ui">
             <i class="fa-solid fa-triangle-exclamation mr-2"></i>Gagal memuat soal.json. Pastikan file tersedia di direktori yang sama.
           </div>`
        );
      });
  }

  function difficultyClass(tingkat) {
    const t = (tingkat || "").toLowerCase();
    if (t.includes("mudah")) return "difficulty-mudah";
    if (t.includes("sedang")) return "difficulty-sedang";
    return "difficulty-sulit";
  }

  function renderCaseGrid(cases) {
    if (!cases || !cases.length) return;
    const progress = getProgress();
    const doneCount = Object.keys(progress).filter((id) => cases.some((c) => c.id === id)).length;

    $("#caseCount").text(`${cases.length} berkas tersedia`);
    $("#caseProgressText").text(`${doneCount} / ${cases.length} kasus selesai`);

    const $grid = $("#caseGrid").empty();

    cases.forEach(function (item, idx) {
      const diffClass = difficultyClass(item.tingkat_kesulitan);
      const entry = progress[item.id];
      const isDone = !!entry;

      const doneBadge = isDone
        ? `<span class="done-badge"><i class="fa-solid fa-circle-check"></i>${entry.skor}% &middot; ${entry.point}/5 poin</span>`
        : `<span class="text-xs font-mono-ui text-slate-500"><i class="fa-regular fa-clock mr-1"></i>${item.durasi_menit} menit</span>`;

      const card = `
        <div class="case-card ${isDone ? "is-done" : ""}" data-id="${item.id}" data-aos="fade-up" data-aos-delay="${(idx % 6) * 60}">
          <div class="flex items-start justify-between mb-3">
            <span class="case-id">${item.id}</span>
            <span class="difficulty-pill ${diffClass}">${item.tingkat_kesulitan}</span>
          </div>
          <div class="font-mono-ui text-[11px] text-cyan mb-2 tracking-tight">${item.kategori}</div>
          <p class="text-sm text-slate-200 leading-relaxed line-clamp-4">${item.pertanyaan}</p>
          <div class="mt-4 pt-3 border-t border-hairline flex items-center justify-between">
            ${doneBadge}
            <span class="text-xs font-mono-ui ${isDone ? "text-accent" : "text-accent"}">
              ${isDone ? "Lihat Hasil" : "Buka Berkas"} <i class="fa-solid fa-chevron-right ml-1"></i>
            </span>
          </div>
        </div>`;
      $grid.append(card);
    });

    $(".case-card").off("click").on("click", function () {
      const id = $(this).data("id");
      const found = state.cases.find((c) => String(c.id) === String(id));
      if (!found) return;

      if (isCaseCompleted(found.id)) {
        openFinishedCase(found);
      } else {
        openCaseFile(found);
      }
    });
  }

  function refreshBerandaStats() {
    const progress = getProgress();
    const entries = Object.values(progress);
    const doneCount = entries.length;
    const totalPoints = entries.reduce((sum, e) => sum + (e.point || 0), 0);
    const avgScore = doneCount ? Math.round(entries.reduce((s, e) => s + (e.skor || 0), 0) / doneCount) : 0;

    $("#statTotalCases").text(state.cases.length || 0);
    $("#statDoneCases").text(doneCount);
    $("#statTotalPoints").text(totalPoints);
    $("#statAvgScore").text(avgScore + "%");
  }

  /* ---------------------------------------------------------------
     6. PLAY SCREEN (TIMER, FORM)
  --------------------------------------------------------------- */
  function openCaseFile(caseItem) {
    if (!getApiKey()) {
      switchScreen("setting");
      $("#settingsApiKeyInput").addClass("focus-accent").focus();
      return;
    }

    state.activeCase = caseItem;
    state.isLocked = false;
    state.lastVerdict = null;

    $("#caseCategoryTag").text(caseItem.kategori);
    $("#caseDifficultyTag").text(caseItem.tingkat_kesulitan);
    $("#caseQuestion").text(caseItem.pertanyaan);

    $("#totalDataInput").val("").prop("disabled", false);
    $("#kesimpulanInput").val("").prop("disabled", false);
    $("#lockedNotice").addClass("hidden");
    $("#submitBtn").prop("disabled", false).html('<i class="fa-solid fa-paper-plane"></i> Ajukan ke Juri AI');
    resetVerdictPanel();

    switchScreen("play");
    startTimer(caseItem.durasi_menit);
  }

  function closePlayScreen() {
    stopTimer();
    state.activeCase = null;
    switchScreen("arsip");
  }

  function startTimer(durasiMenit) {
    stopTimer();
    state.remainingSeconds = Math.max(1, Math.round(durasiMenit * 60));
    updateTimerDisplay();

    state.timerInterval = setInterval(function () {
      state.remainingSeconds -= 1;
      updateTimerDisplay();
      if (state.remainingSeconds <= 0) {
        stopTimer();
        lockCaseFile();
      }
    }, 1000);
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function updateTimerDisplay() {
    const m = Math.floor(state.remainingSeconds / 60);
    const s = state.remainingSeconds % 60;
    const label = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const $box = $("#timerBox").text(label);

    $box.removeClass("timer-warning timer-danger");
    if (state.remainingSeconds <= 60) $box.addClass("timer-danger");
    else if (state.remainingSeconds <= 120) $box.addClass("timer-warning");
  }

  function lockCaseFile() {
    state.isLocked = true;
    $("#totalDataInput, #kesimpulanInput").prop("disabled", true);
    $("#submitBtn").prop("disabled", true);
    $("#lockedNotice").removeClass("hidden");

    const $toast = $("#timeUpToast").removeClass("hidden");
    setTimeout(() => $toast.addClass("hidden"), 6000);
  }

  /* ---------------------------------------------------------------
     7. SUBMISSION -> GROQ API -> VERDICT -> "SELESAI"
  --------------------------------------------------------------- */
  function resetVerdictPanel() {
    $("#verdictLoading, #verdictResult").addClass("hidden");
    $("#verdictIdle").removeClass("hidden");
    $("#verdictResult").empty();
  }

  function skorToPoint(skor) {
    if (skor < 20) return 0;
    if (skor < 40) return 1;
    if (skor < 60) return 2;
    if (skor < 80) return 3;
    if (skor <= 90) return 4;
    return 5; // 91 - 100
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (state.isLocked || state.isSubmitting) return;

    const apiKey = getApiKey();
    if (!apiKey) {
      switchScreen("setting");
      return;
    }

    const totalData = $("#totalDataInput").val().trim();
    const kesimpulan = $("#kesimpulanInput").val().trim();
    if (!totalData || !kesimpulan) return;

    state.isSubmitting = true;
    $("#submitBtn").prop("disabled", true).html('<i class="fa-solid fa-circle-notch fa-spin"></i> Mengirim...');
    $("#verdictIdle, #verdictResult").addClass("hidden");
    $("#verdictLoading").removeClass("hidden");

    const c = state.activeCase;
    const systemPrompt =
      "Kamu adalah Juri Game Detektif Data yang tegas dan objektif. Kamu HANYA membalas dengan satu objek JSON valid, " +
      "tanpa teks lain, tanpa markdown, tanpa backtick. Format JSON WAJIB persis seperti ini:\n" +
      '{"status": "BENAR" | "SALAH" | "SEBAGIAN BENAR", "skor": <angka 0-100>, "penjelasan": "<maksimal 3 kalimat>"}';

    const userPrompt =
      `Pertanyaan: ${c.pertanyaan}\n` +
      `Fakta Sebenarnya: ${c.kunci_fakta}\n` +
      `Input Pemain (Total Data): ${totalData}\n` +
      `Input Pemain (Kesimpulan): ${kesimpulan}\n\n` +
      "Tugasmu: Evaluasi apakah analisis pemain sesuai dengan fakta. Balas hanya dengan JSON sesuai format yang ditentukan.";

    $.ajax({
      url: GROQ_ENDPOINT,
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: `Bearer ${apiKey}` },
      data: JSON.stringify({
        model: getModel(),
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    })
      .done(function (response) {
        const raw = response?.choices?.[0]?.message?.content || "";
        const parsed = parseVerdictJson(raw);
        if (parsed) {
          renderVerdict(parsed, { totalData, kesimpulan });
        } else {
          renderVerdictError("Juri AI merespons dalam format yang tidak terbaca. Coba ajukan ulang berkas ini.");
        }
      })
      .fail(function (xhr) {
        let msg = "Gagal menghubungi Groq API. Periksa koneksi internet.";
        if (xhr.status === 401) msg = "API Key ditolak (401). Periksa kembali kunci Groq milikmu di halaman Setting.";
        else if (xhr.status === 429) msg = "Batas permintaan tercapai (429). Coba lagi sesaat lagi.";
        else if (xhr.responseJSON && xhr.responseJSON.error && xhr.responseJSON.error.message) msg = xhr.responseJSON.error.message;
        renderVerdictError(msg);
      })
      .always(function () {
        state.isSubmitting = false;
        if (!state.isLocked) $("#submitBtn").prop("disabled", false);
        $("#submitBtn").html('<i class="fa-solid fa-paper-plane"></i> Ajukan ke Juri AI');
      });
  }

  function parseVerdictJson(raw) {
    if (!raw) return null;
    let cleaned = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (err2) { return null; }
      }
      return null;
    }
  }

  function normalizeStatus(status) {
    const s = (status || "").toString().toUpperCase();
    if (s.includes("BENAR") && !s.includes("SALAH") && !s.includes("SEBAGIAN")) return "BENAR";
    if (s.includes("SALAH")) return "SALAH";
    return "SEBAGIAN BENAR";
  }

  function verdictVisuals(status) {
    switch (status) {
      case "BENAR": return { cls: "verdict-benar", icon: "fa-circle-check", fill: "#10b981" };
      case "SALAH": return { cls: "verdict-salah", icon: "fa-circle-xmark", fill: "#ef4444" };
      default: return { cls: "verdict-sebagian", icon: "fa-triangle-exclamation", fill: "#eab308" };
    }
  }

  function renderVerdict(parsed, playerInput) {
    const status = normalizeStatus(parsed.status);
    const skorRaw = Number(parsed.skor);
    const skor = Number.isFinite(skorRaw) ? Math.max(0, Math.min(100, Math.round(skorRaw))) : 0;
    const point = skorToPoint(skor);
    const penjelasan = (parsed.penjelasan || "Tidak ada penjelasan tambahan dari Juri AI.").toString();
    const v = verdictVisuals(status);

    state.lastVerdict = { status, skor, point, penjelasan, ...playerInput };

    $("#verdictLoading").addClass("hidden");
    const $result = $("#verdictResult");

    $result.html(`
      <div data-aos="fade-up">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="verdict-badge ${v.cls}"><i class="fa-solid ${v.icon}"></i> ${status}</span>
          <span class="point-chip"><i class="fa-solid fa-star"></i> ${point}/5 poin</span>
        </div>

        <div class="mt-4 flex items-end justify-between">
          <span class="text-[11px] font-mono-ui text-slate-500">SKOR ANALISIS</span>
          <span class="score-ring text-2xl" style="color:${v.fill}">${skor}<span class="text-sm text-slate-500">/100</span></span>
        </div>
        <div class="score-track mt-1.5"><div class="score-fill" style="width:0%; background:${v.fill};"></div></div>

        <p class="text-sm text-slate-300 leading-relaxed mt-4">${escapeHtml(penjelasan)}</p>

        <button type="button" id="finalizeBtn" class="btn-primary w-full mt-5 inline-flex items-center justify-center gap-2 text-sm px-5 py-2.5 rounded-md">
          <i class="fa-solid fa-flag-checkered"></i> Selesai
        </button>
      </div>
    `);

    $result.removeClass("hidden");
    requestAnimationFrame(() => requestAnimationFrame(() => $result.find(".score-fill").css("width", skor + "%")));

    $("#finalizeBtn").on("click", finalizeCase);
  }

  function renderVerdictError(message) {
    $("#verdictLoading").addClass("hidden");
    $("#verdictResult").html(`
      <div class="text-center py-6" data-aos="fade-up">
        <i class="fa-solid fa-triangle-exclamation text-2xl text-red-400 mb-3"></i>
        <p class="text-xs font-mono-ui text-red-300 leading-relaxed">${escapeHtml(message)}</p>
      </div>
    `).removeClass("hidden");
  }

  function finalizeCase() {
    if (!state.lastVerdict || !state.activeCase) return;
    // Validasi: jika kasus ini sudah pernah dikunci sebelumnya (edge-case double click / re-entry),
    // jangan pernah menimpa poin yang sudah tersimpan.
    if (isCaseCompleted(state.activeCase.id)) {
      openFinishedCase(state.activeCase);
      return;
    }

    stopTimer();
    const entry = {
      status: state.lastVerdict.status,
      skor: state.lastVerdict.skor,
      point: state.lastVerdict.point,
      penjelasan: state.lastVerdict.penjelasan,
      totalData: state.lastVerdict.totalData,
      kesimpulan: state.lastVerdict.kesimpulan,
      completedAt: new Date().toISOString(),
    };
    saveProgressForCase(state.activeCase.id, entry);
    renderFinishScreen(state.activeCase, entry);
    switchScreen("finish");
  }

  /* ---------------------------------------------------------------
     8. FINISH SCREEN (fresh result AND read-only recap)
  --------------------------------------------------------------- */
  function openFinishedCase(caseItem) {
    const entry = getCaseProgress(caseItem.id);
    if (!entry) { openCaseFile(caseItem); return; }
    renderFinishScreen(caseItem, entry);
    switchScreen("finish");
  }

  function renderFinishScreen(caseItem, entry) {
    const v = verdictVisuals(entry.status);
    const dateLabel = entry.completedAt
      ? new Date(entry.completedAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })
      : "-";

    $("#finishContent").html(`
      <div class="text-center mb-6">
        <div class="w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-3" style="background:rgba(${hexToRgbSafe(v.fill)},0.12); border:1px solid rgba(${hexToRgbSafe(v.fill)},0.4);">
          <i class="fa-solid fa-flag-checkered text-2xl" style="color:${v.fill}"></i>
        </div>
        <h2 class="font-mono-ui text-lg text-slate-100 font-semibold">Berkas Ditutup</h2>
        <p class="text-xs text-slate-500 mt-1 font-mono-ui">${escapeHtml(caseItem.id)} &middot; ${escapeHtml(caseItem.kategori)}</p>
      </div>

      <div class="flex items-center justify-center gap-2 flex-wrap mb-5">
        <span class="verdict-badge ${v.cls}"><i class="fa-solid ${v.icon}"></i> ${escapeHtml(entry.status)}</span>
        <span class="point-chip"><i class="fa-solid fa-star"></i> ${entry.point}/5 poin</span>
      </div>

      <div class="flex items-end justify-between">
        <span class="text-[11px] font-mono-ui text-slate-500">SKOR ANALISIS</span>
        <span class="score-ring text-2xl" style="color:${v.fill}">${entry.skor}<span class="text-sm text-slate-500">/100</span></span>
      </div>
      <div class="score-track mt-1.5"><div class="score-fill" style="width:${entry.skor}%; background:${v.fill};"></div></div>

      <p class="text-sm text-slate-300 leading-relaxed mt-4">${escapeHtml(entry.penjelasan)}</p>

      <div class="mt-5 pt-4 border-t border-hairline space-y-3">
        <div>
          <div class="text-[11px] font-mono-ui text-slate-500 mb-1">JAWABANMU — TOTAL DATA</div>
          <p class="text-xs text-slate-400 leading-relaxed font-mono-ui">${escapeHtml(entry.totalData || "-")}</p>
        </div>
        <div>
          <div class="text-[11px] font-mono-ui text-slate-500 mb-1">JAWABANMU — KESIMPULAN</div>
          <p class="text-xs text-slate-400 leading-relaxed">${escapeHtml(entry.kesimpulan || "-")}</p>
        </div>
        <div>
          <div class="text-[11px] font-mono-ui text-slate-500 mb-1">FAKTA REFERENSI</div>
          <p class="text-xs text-slate-400 leading-relaxed">${escapeHtml(caseItem.kunci_fakta)}</p>
        </div>
      </div>

      <p class="text-[11px] text-slate-600 font-mono-ui mt-5 text-center">Diselesaikan pada ${escapeHtml(dateLabel)}</p>
    `);
  }

  /* ---------------------------------------------------------------
     9. UTILITIES
  --------------------------------------------------------------- */
  function hexToRgbSafe(hexOrRgb) {
    if (hexOrRgb.startsWith("#")) return hexToRgbString(hexOrRgb);
    return hexOrRgb;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();