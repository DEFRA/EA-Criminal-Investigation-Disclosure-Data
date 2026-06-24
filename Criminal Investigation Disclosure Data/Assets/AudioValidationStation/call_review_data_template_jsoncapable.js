// Replace values below in UiPath and save as call_review_data.js
// You can supply EITHER:
//   A) timelineSeconds  -> prebuilt 1-second review blocks
//   B) waveformPoints   -> raw waveform points (the app will build timelineSeconds automatically)
window.CALL_REVIEW_DATA = {
  audioSrc: "file:///C:/Users/da000087/Downloads/Your%20Audio%20File.mp3",
  transcript: "Full transcript text here...",

  // Option A: preferred if your upstream process already creates final timeline blocks
  // timelineSeconds: [
  //   {
  //     start_ms: 0,
  //     end_ms: 1000,
  //     mean_rms: 0.000815,
  //     max_peak: 0.002091,
  //     state: "low",
  //     intensity: 0.21,
  //     intensity_smooth: 0.24
  //   }
  // ],

  // Option B: raw waveform points (matches your new transcript_waveform.json structure)
  waveformPoints: [
    {
      timestamp_ms: 0,
      duration_ms: 100,
      amplitude_rms: 0.001926,
      amplitude_peak: 0.009064
    }
  ],

  metadata: {
    caseId: "CASE-000123",
    callerName: "John Smith",
    callDate: "10/06/2026 14:30",
    classification: "Sensative",
    reviewNotes: "Optional reviewer notes"
  }
};
