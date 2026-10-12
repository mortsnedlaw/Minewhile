function getEl<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing referral UI element ${selector}`);
  return value;
}

async function copyValue(input: HTMLInputElement, status: HTMLElement) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(input.value);
    } else {
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
      document.execCommand("copy");
    }
    status.textContent = "Copied.";
  } catch {
    status.textContent = "Could not copy automatically.";
  }
}

function createReferralUrl(id: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("r", id);
  return url.toString();
}

function createManagementLink(id: string, secret: string): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = `manage=${encodeURIComponent(id)}.${encodeURIComponent(secret)}`;
  return url.toString();
}

function oneShot(relayUrl: string, payload: unknown, onMessage: (message: any) => boolean, onError: (message: string) => void) {
  const socket = new WebSocket(relayUrl);
  const timer = window.setTimeout(() => {
    try { socket.close(); } catch { /* ignore */ }
    onError("Request timed out.");
  }, 10_000);

  socket.onopen = () => socket.send(JSON.stringify(payload));
  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(event.data); }
    catch { return; }
    if (onMessage(message)) {
      window.clearTimeout(timer);
      socket.close(1000, "done");
    }
  };
  socket.onerror = () => {
    window.clearTimeout(timer);
    onError("Could not connect to Minewhile relay.");
  };
}

export function initReferralCreator(relayUrl: string) {
  const currency = getEl<HTMLSelectElement>("#referralCurrency");
  const wallet = getEl<HTMLInputElement>("#referralWallet");
  const create = getEl<HTMLButtonElement>("#createReferral");
  const status = getEl<HTMLElement>("#referralCreateStatus");
  const result = getEl<HTMLElement>("#referralCreateResult");
  const referralLink = getEl<HTMLInputElement>("#createdReferralLink");
  const managementLink = getEl<HTMLInputElement>("#createdManagementLink");
  const managementSecret = getEl<HTMLInputElement>("#createdManagementSecret");
  const copyReferral = getEl<HTMLButtonElement>("#copyReferralLink");
  const copyManagement = getEl<HTMLButtonElement>("#copyManagementLink");
  const copySecret = getEl<HTMLButtonElement>("#copyManagementSecret");

  const manageId = getEl<HTMLInputElement>("#manageReferralId");
  const manageSecret = getEl<HTMLInputElement>("#manageReferralSecret");
  const manageLoad = getEl<HTMLButtonElement>("#loadReferralManagement");
  const managePanel = getEl<HTMLElement>("#referralManagementResult");
  const manageCurrency = getEl<HTMLSelectElement>("#manageReferralCurrency");
  const manageWallet = getEl<HTMLInputElement>("#manageReferralWallet");
  const manageEnabled = getEl<HTMLInputElement>("#manageReferralEnabled");
  const manageSave = getEl<HTMLButtonElement>("#saveReferralManagement");
  const manageStatus = getEl<HTMLElement>("#referralManagementStatus");
  const manageAccepted = getEl<HTMLElement>("#manageAcceptedShares");
  const manageRejected = getEl<HTMLElement>("#manageRejectedShares");
  const manageLastShare = getEl<HTMLElement>("#manageLastShare");

  const mainCurrency = document.querySelector<HTMLSelectElement>("#currency");
  const mainWallet = document.querySelector<HTMLInputElement>("#wallet");
  if (mainCurrency) {
    currency.innerHTML = mainCurrency.innerHTML;
    manageCurrency.innerHTML = mainCurrency.innerHTML;
    currency.value = mainCurrency.value;
  }
  if (mainWallet?.value) wallet.value = mainWallet.value;

  function loadManagement() {
    const id = manageId.value.trim().toUpperCase();
    const secret = manageSecret.value.trim();
    if (!id || !secret) {
      manageStatus.textContent = "Referral ID and management secret are required.";
      return;
    }
    manageStatus.textContent = "Loading…";
    oneShot(
      relayUrl,
      { type: "beneficiary_manage_get", beneficiaryId: id, managementSecret: secret },
      (message) => {
        if (message.type === "beneficiary_management") {
          const b = message.beneficiary;
          manageCurrency.value = String(b.payoutCurrency ?? "");
          manageWallet.value = String(b.payoutAddress ?? "");
          manageEnabled.checked = b.enabled !== false;
          manageAccepted.textContent = String(b.acceptedShares ?? 0);
          manageRejected.textContent = String(b.rejectedShares ?? 0);
          manageLastShare.textContent = b.lastShareAt ? new Date(Number(b.lastShareAt)).toLocaleString() : "—";
          managePanel.hidden = false;
          manageStatus.textContent = `Managing referral ${String(b.id ?? id)}.`;
          return true;
        }
        if (message.type === "error") {
          manageStatus.textContent = String(message.message ?? "Could not load referral.");
          return true;
        }
        return false;
      },
      (message) => manageStatus.textContent = message
    );
  }

  create.onclick = () => {
    const payoutCurrency = currency.value.trim().toUpperCase();
    const payoutAddress = wallet.value.trim();
    if (!payoutAddress) {
      status.textContent = "Enter a payout address.";
      return;
    }
    create.disabled = true;
    status.textContent = "Creating referral…";
    result.hidden = true;

    oneShot(
      relayUrl,
      { type: "beneficiary_create", payoutCurrency, payoutAddress },
      (message) => {
        if (message.type === "beneficiary_created") {
          const id = String(message.beneficiaryId ?? "");
          const secret = String(message.managementSecret ?? "");
          referralLink.value = createReferralUrl(id);
          managementSecret.value = secret;
          managementLink.value = createManagementLink(id, secret);
          result.hidden = false;
          status.textContent = `Referral ${id} created. Save the management link now.`;
          manageId.value = id;
          manageSecret.value = secret;
          create.disabled = false;
          return true;
        }
        if (message.type === "error") {
          status.textContent = String(message.message ?? "Referral creation failed.");
          create.disabled = false;
          return true;
        }
        return false;
      },
      (message) => {
        status.textContent = message;
        create.disabled = false;
      }
    );
  };

  copyReferral.onclick = () => void copyValue(referralLink, status);
  copyManagement.onclick = () => void copyValue(managementLink, status);
  copySecret.onclick = () => void copyValue(managementSecret, status);
  manageLoad.onclick = loadManagement;

  manageSave.onclick = () => {
    manageStatus.textContent = "Saving…";
    oneShot(
      relayUrl,
      {
        type: "beneficiary_manage_update",
        beneficiaryId: manageId.value.trim().toUpperCase(),
        managementSecret: manageSecret.value.trim(),
        payoutCurrency: manageCurrency.value,
        payoutAddress: manageWallet.value.trim(),
        enabled: manageEnabled.checked
      },
      (message) => {
        if (message.type === "beneficiary_management") {
          manageStatus.textContent = "Referral settings saved.";
          return true;
        }
        if (message.type === "error") {
          manageStatus.textContent = String(message.message ?? "Could not save referral.");
          return true;
        }
        return false;
      },
      (message) => manageStatus.textContent = message
    );
  };

  const match = location.hash.match(/^#manage=([A-HJ-NP-Z2-9]{8})\.([^\s]+)$/i);
  if (match) {
    manageId.value = decodeURIComponent(match[1]).toUpperCase();
    manageSecret.value = decodeURIComponent(match[2]);
    window.setTimeout(loadManagement, 0);
  }
}
