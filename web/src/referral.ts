function getEl<T extends HTMLElement>(
  selector: string
): T {
  const value = document.querySelector<T>(selector);

  if (!value) {
    throw new Error(`Missing referral UI element ${selector}`);
  }

  return value;
}

async function copyValue(
  input: HTMLInputElement,
  status: HTMLElement
) {
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

function createManagementLink(
  id: string,
  secret: string
): string {
  const url = new URL(location.href);

  url.search = "";

  /*
   * Fragment is intentionally used so the management secret is not
   * part of the normal HTTP request path or Referer header.
   */
  url.hash =
    `manage=${encodeURIComponent(id)}.${encodeURIComponent(secret)}`;

  return url.toString();
}

export function initReferralCreator(
  relayUrl: string
) {
  const currency =
    getEl<HTMLSelectElement>("#referralCurrency");

  const wallet =
    getEl<HTMLInputElement>("#referralWallet");

  const create =
    getEl<HTMLButtonElement>("#createReferral");

  const status =
    getEl<HTMLElement>("#referralCreateStatus");

  const result =
    getEl<HTMLElement>("#referralCreateResult");

  const referralLink =
    getEl<HTMLInputElement>("#createdReferralLink");

  const managementLink =
    getEl<HTMLInputElement>("#createdManagementLink");

  const managementSecret =
    getEl<HTMLInputElement>("#createdManagementSecret");

  const copyReferral =
    getEl<HTMLButtonElement>("#copyReferralLink");

  const copyManagement =
    getEl<HTMLButtonElement>("#copyManagementLink");

  const copySecret =
    getEl<HTMLButtonElement>("#copyManagementSecret");

  const mainCurrency =
    document.querySelector<HTMLSelectElement>("#currency");

  const mainWallet =
    document.querySelector<HTMLInputElement>("#wallet");

  if (mainCurrency) {
    currency.innerHTML = mainCurrency.innerHTML;
    currency.value = mainCurrency.value;
  }

  if (mainWallet?.value) {
    wallet.value = mainWallet.value;
  }

  create.onclick = () => {
    const payoutCurrency =
      currency.value.trim().toUpperCase();

    const payoutAddress =
      wallet.value.trim();

    if (!payoutAddress) {
      status.textContent = "Enter a payout address.";
      return;
    }

    create.disabled = true;
    status.textContent = "Creating referral…";
    result.hidden = true;

    const socket = new WebSocket(relayUrl);
    let finished = false;

    const finish = () => {
      if (finished) return;

      finished = true;
      create.disabled = false;

      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "Referral creation completed");
      }
    };

    const timeout = window.setTimeout(() => {
      status.textContent = "Referral creation timed out.";

      try {
        socket.close();
      } catch {
        // ignore
      }

      finish();
    }, 10_000);

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "beneficiary_create",
        payoutCurrency,
        payoutAddress
      }));
    };

    socket.onmessage = (event) => {
      let message: any;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "beneficiary_created") {
        window.clearTimeout(timeout);

        const id = String(message.beneficiaryId ?? "");
        const secret = String(message.managementSecret ?? "");

        referralLink.value =
          createReferralUrl(id);

        managementSecret.value =
          secret;

        managementLink.value =
          createManagementLink(id, secret);

        result.hidden = false;

        status.textContent =
          `Referral ${id} created. Save the management secret/link now.`;

        finish();
        return;
      }

      if (message.type === "error") {
        window.clearTimeout(timeout);

        status.textContent =
          String(message.message ?? "Referral creation failed.");

        finish();
      }
    };

    socket.onerror = () => {
      window.clearTimeout(timeout);
      status.textContent = "Could not connect to Minewhile relay.";
      finish();
    };

    socket.onclose = () => {
      window.clearTimeout(timeout);

      if (!finished) {
        status.textContent = "Referral connection closed.";
      }

      finish();
    };
  };

  copyReferral.onclick = () =>
    void copyValue(referralLink, status);

  copyManagement.onclick = () =>
    void copyValue(managementLink, status);

  copySecret.onclick = () =>
    void copyValue(managementSecret, status);
}
