/* ===================================================================
   DATA DETECTIVE / OSINT CHALLENGE — application logic
   Sections:
   1. State & constants
   2. API key handling (localStorage)
   3. Case board (fetch soal.json, render cards)
   4. Case file workspace (timer, lock, navigation)
   5. Submission -> Groq API -> verdict rendering
=================================================================== */

(function () {
  "use strict";

  const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
  const GROQ_MODEL = "openai/gpt-oss-120b";
  const STORAGE_KEY = "dataDetective_groqApiKey";

  const state = {
    cases: [],
    activeCase: null,
    timerInterval: null,
    remainingSeconds: 0,
    isLocked: false,
    isSubmitting: false,
  };

  const $ = window.jQuery;

  /* ---------------------------------------------------------------
     1. INIT
  --------------------------------------------------------------- */
  $(document).ready(function () {
    AOS.init({ duration: 550, easing: "ease-out-cubic", once: true, offset: 40 });

    initApiKeyUI();
    loadCases();
    bindGlobalEvents();
  });

  function bindGlobalEvents() {
    $("#backToBoardBtn").on("click", closeCaseFile);
    $("#submissionForm").on("submit", handleSubmit);
  }

  /* ---------------------------------------------------------------
     2. API KEY HANDLING
  --------------------------------------------------------------- */
  function getApiKey() {
    return localStorage.getItem(STORAGE_KEY) || "";
  }

  function setApiKey(key) {
    if (key) localStorage.setItem(STORAGE_KEY, key);
  }

  function clearApiKey() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function refreshStatusBadge() {
    const hasKey = !!getApiKey();
    const $badge = $("#statusBadge");
    if (hasKey) {
      $badge.removeClass("text-slate-500").addClass("text-emerald border-emerald/30");
      $badge.html('<i class="fa-solid fa-circle text-[6px]"></i> API terhubung');
    } else {
      $badge.removeClass("text-emerald border-emerald/30").addClass("text-slate-500");
      $badge.html('<i class="fa-solid fa-circle text-[6px]"></i> API belum terhubung');
    }
  }

  function initApiKeyUI() {
    const existing = getApiKey();
    if (existing) {
      $("#apiKeyInput").val(existing);
      $("#apiKeySavedNote").removeClass("hidden");
    }
    refreshStatusBadge();

    const apiModalEl = document.getElementById("apiKeyModal");
    const apiModal = new bootstrap.Modal(apiModalEl);

    $("#openApiModalBtn").on("click", function () {
      apiModal.show();
    });

    // If no key yet, gently prompt on first load
    if (!existing) {
      setTimeout(() => apiModal.show(), 600);
    }

    $("#toggleApiKeyVisibility").on("click", function () {
      const $input = $("#apiKeyInput");
      const isPassword = $input.attr("type") === "password";
      $input.attr("type", isPassword ? "text" : "password");
      $(this).find("i").toggleClass("fa-eye fa-eye-slash");
    });

    $("#saveApiKeyBtn").on("click", function () {
      const val = $("#apiKeyInput").val().trim();
      if (!val) {
        $("#apiKeyInput").addClass("is-invalid").focus();
        return;
      }
      setApiKey(val);
      $("#apiKeySavedNote").removeClass("hidden");
      refreshStatusBadge();
      apiModal.hide();
    });

    $("#clearApiKeyBtn").on("click", function () {
      clearApiKey();
      $("#apiKeyInput").val("");
      $("#apiKeySavedNote").addClass("hidden");
      refreshStatusBadge();
    });
  }

  /* ---------------------------------------------------------------
     3. CASE BOARD
  --------------------------------------------------------------- */
  function loadCases() {
    $.getJSON("soal.json")
      .done(function (data) {
        state.cases = data || [];
        renderCaseGrid(state.cases);
      })
      .fail(function () {
        $("#caseGrid").html(
          `<div class="col-span-full rounded-lg border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-300 font-mono">
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
    $("#caseCount").text(`${cases.length} berkas tersedia`);

    const $grid = $("#caseGrid").empty();

    cases.forEach(function (item, idx) {
      const diffClass = difficultyClass(item.tingkat_kesulitan);
      const card = `
        <div class="case-card" data-id="${item.id}" data-aos="fade-up" data-aos-delay="${(idx % 6) * 60}">
          <div class="flex items-start justify-between mb-3">
            <span class="case-id">${item.id}</span>
            <span class="difficulty-pill ${diffClass}">${item.tingkat_kesulitan}</span>
          </div>
          <div class="font-mono text-[11px] text-cyan mb-2 tracking-tight">${item.kategori}</div>
          <p class="text-sm text-slate-200 leading-relaxed line-clamp-4">${item.pertanyaan}</p>
          <div class="mt-4 pt-3 border-t border-hairline flex items-center justify-between">
            <span class="text-xs font-mono text-slate-500">
              <i class="fa-regular fa-clock mr-1"></i>${item.durasi_menit} menit
            </span>
            <span class="text-xs font-mono text-emerald group-hover:translate-x-0.5 transition-transform">
              Buka Berkas <i class="fa-solid fa-chevron-right ml-1"></i>
            </span>
          </div>
        </div>`;
      $grid.append(card);
    });

    $(".case-card").on("click", function () {
      const id = $(this).data("id");
      const found = state.cases.find((c) => c.id === id);
      if (found) openCaseFile(found);
    });
  }

  /* ---------------------------------------------------------------
     4. CASE FILE WORKSPACE
  --------------------------------------------------------------- */
  function openCaseFile(caseItem) {
    if (!getApiKey()) {
      const apiModal = bootstrap.Modal.getOrCreateInstance(document.getElementById("apiKeyModal"));
      apiModal.show();
    }

    state.activeCase = caseItem;
    state.isLocked = false;

    $("#caseCategoryTag").text(caseItem.kategori);
    $("#caseDifficultyTag").text(caseItem.tingkat_kesulitan);
    $("#caseQuestion").text(caseItem.pertanyaan);

    // reset form + verdict panel
    $("#totalDataInput").val("");
    $("#kesimpulanInput").val("");
    $("#lockedNotice").addClass("hidden");
    $("#submitBtn").prop("disabled", false);
    $("#totalDataInput, #kesimpulanInput").prop("disabled", false);
    resetVerdictPanel();

    $("#caseBoardSection").addClass("hidden");
    $("#caseFileSection").removeClass("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });

    startTimer(caseItem.durasi_menit);
  }

  function closeCaseFile() {
    stopTimer();
    state.activeCase = null;
    $("#caseFileSection").addClass("hidden");
    $("#caseBoardSection").removeClass("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    if (state.remainingSeconds <= 60) {
      $box.addClass("timer-danger");
    } else if (state.remainingSeconds <= 120) {
      $box.addClass("timer-warning");
    }
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
     5. SUBMISSION -> GROQ API -> VERDICT
  --------------------------------------------------------------- */
  function resetVerdictPanel() {
    $("#verdictLoading, #verdictResult").addClass("hidden");
    $("#verdictIdle").removeClass("hidden");
    $("#verdictResult").empty();
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (state.isLocked || state.isSubmitting) return;

    const apiKey = getApiKey();
    if (!apiKey) {
      const apiModal = bootstrap.Modal.getOrCreateInstance(document.getElementById("apiKeyModal"));
      apiModal.show();
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
        model: GROQ_MODEL,
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
          renderVerdict(parsed);
        } else {
          renderVerdictError(
            "Juri AI merespons dalam format yang tidak terbaca. Coba ajukan ulang berkas ini."
          );
        }
      })
      .fail(function (xhr) {
        let msg = "Gagal menghubungi Groq API. Periksa koneksi internet.";
        if (xhr.status === 401) msg = "API Key ditolak (401). Periksa kembali kunci Groq milikmu.";
        else if (xhr.status === 429) msg = "Batas permintaan tercapai (429). Coba lagi sesaat lagi.";
        else if (xhr.responseJSON?.error?.message) msg = xhr.responseJSON.error.message;
        renderVerdictError(msg);
      })
      .always(function () {
        state.isSubmitting = false;
        if (!state.isLocked) {
          $("#submitBtn").prop("disabled", false);
        }
        $("#submitBtn").html('<i class="fa-solid fa-paper-plane"></i> Ajukan ke Juri AI');
      });
  }

  function parseVerdictJson(raw) {
    if (!raw) return null;
    // Strip common markdown fences just in case the model adds them anyway.
    let cleaned = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

    // Try direct parse first, then fall back to extracting the first {...} block.
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (err2) {
          return null;
        }
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
      case "BENAR":
        return { cls: "verdict-benar", icon: "fa-circle-check", fill: "#10b981" };
      case "SALAH":
        return { cls: "verdict-salah", icon: "fa-circle-xmark", fill: "#ef4444" };
      default:
        return { cls: "verdict-sebagian", icon: "fa-triangle-exclamation", fill: "#eab308" };
    }
  }

  function renderVerdict(parsed) {
    const status = normalizeStatus(parsed.status);
    const skorRaw = Number(parsed.skor);
    const skor = Number.isFinite(skorRaw) ? Math.max(0, Math.min(100, Math.round(skorRaw))) : 0;
    const penjelasan = (parsed.penjelasan || "Tidak ada penjelasan tambahan dari Juri AI.").toString();
    const v = verdictVisuals(status);

    $("#verdictLoading").addClass("hidden");
    const $result = $("#verdictResult");

    $result.html(`
      <div data-aos="fade-up">
        <span class="verdict-badge ${v.cls}">
          <i class="fa-solid ${v.icon}"></i> ${status}
        </span>

        <div class="mt-4 flex items-end justify-between">
          <span class="text-[11px] font-mono text-slate-500">SKOR ANALISIS</span>
          <span class="score-ring text-2xl" style="color:${v.fill}">${skor}<span class="text-sm text-slate-500">/100</span></span>
        </div>
        <div class="score-track mt-1.5">
          <div class="score-fill" style="width:0%; background:${v.fill};"></div>
        </div>

        <p class="text-sm text-slate-300 leading-relaxed mt-4">${escapeHtml(penjelasan)}</p>

        <div class="mt-5 pt-4 border-t border-hairline">
          <div class="text-[11px] font-mono text-slate-500 mb-1.5">FAKTA REFERENSI</div>
          <p class="text-xs text-slate-400 leading-relaxed">${escapeHtml(state.activeCase.kunci_fakta)}</p>
        </div>
      </div>
    `);

    $result.removeClass("hidden");
    // animate score bar after paint
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        $result.find(".score-fill").css("width", skor + "%");
      });
    });
  }

  function renderVerdictError(message) {
    $("#verdictLoading").addClass("hidden");
    const $result = $("#verdictResult");
    $result.html(`
      <div class="text-center py-6" data-aos="fade-up">
        <i class="fa-solid fa-triangle-exclamation text-2xl text-red-400 mb-3"></i>
        <p class="text-xs font-mono text-red-300 leading-relaxed">${escapeHtml(message)}</p>
      </div>
    `).removeClass("hidden");
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
