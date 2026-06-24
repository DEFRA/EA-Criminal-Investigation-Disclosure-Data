(function () {

  const DATA = window.IMAGE_VALIDATION_DATA || {};

  const img = document.getElementById("sourceImage");
  const ocrText = document.getElementById("ocrText");
  const charCount = document.getElementById("charCount");
  const markCorrect = document.getElementById("markCorrect");

  let originalText = "";
  let zoom = 1;

  function updateCount() {
    charCount.textContent = `${ocrText.value.length} chars`;
  }

  function applyZoom() {
    img.style.transform = `scale(${zoom})`;
  }

  function loadData() {
    if (DATA.imageSrc) {
      img.src = DATA.imageSrc;
    }

    if (DATA.ocrText) {
      ocrText.value = DATA.ocrText;
      originalText = DATA.ocrText;
    }

    if (DATA.metadata) {
      document.getElementById("caseId").value = DATA.metadata.caseId || "";
      document.getElementById("docType").value = DATA.metadata.docType || "";
      document.getElementById("processedDate").value = DATA.metadata.processedDate || "";
      document.getElementById("classification").value = DATA.metadata.classification || "";
      document.getElementById("reviewNotes").value = DATA.metadata.reviewNotes || "";
    }

    updateCount();
  }

  function resetText() {
    ocrText.value = originalText;
    updateCount();
  }

  function save() {
    const payload = {
      ocrText: ocrText.value,
      isCorrect: markCorrect.checked,
      metadata: {
        caseId: document.getElementById("caseId").value,
        docType: document.getElementById("docType").value,
        processedDate: document.getElementById("processedDate").value,
        classification: document.getElementById("classification").value,
        reviewNotes: document.getElementById("reviewNotes").value
      }
    };

    console.log("SAVE", payload);
  }

  // EVENTS
  ocrText.addEventListener("input", updateCount);
  document.getElementById("btnReset").addEventListener("click", resetText);
  document.getElementById("btnSaveContinue").addEventListener("click", save);

  document.getElementById("zoomIn").onclick = () => { zoom += 0.1; applyZoom(); };
  document.getElementById("zoomOut").onclick = () => { zoom = Math.max(0.5, zoom - 0.1); applyZoom(); };
  document.getElementById("resetZoom").onclick = () => { zoom = 1; applyZoom(); };

  loadData();

})();