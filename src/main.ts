import "./styles/app.css";
import "./styles/mobile.css";
import {
  state,
  computeModel,
  buildDemoDashboardPayload,
  encodePairingCode,
  parsePairingCode,
  savePwaConfig,
  applyPayloadToState,
  switchMainPage,
  simulateDemoWrite,
  applyAndVerifyPairing,
  loadInitialData
} from "./app/legacy-app.js";

// Expose test and debug hooks cleanly on window for VM / console interoperability
if (typeof window !== "undefined") {
  Object.assign(window, {
    state,
    computeModel,
    buildDemoDashboardPayload,
    encodePairingCode,
    parsePairingCode,
    savePwaConfig,
    applyPayloadToState,
    switchMainPage,
    simulateDemoWrite,
    applyAndVerifyPairing,
    loadInitialData
  });
}

loadInitialData();
