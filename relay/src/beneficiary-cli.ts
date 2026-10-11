import {
  createBeneficiary
} from "./beneficiary.js";
import {
  isSupportedCurrency
} from "./config.js";

const [currencyRaw, addressRaw] = process.argv.slice(2);

const currency = String(currencyRaw ?? "").trim().toUpperCase();
const address = String(addressRaw ?? "").trim();

if (!currency || !address) {
  console.error(
    "Usage: npm run beneficiary:create -- NENG WALLET_ADDRESS"
  );
  process.exit(1);
}

if (!isSupportedCurrency(currency)) {
  console.error(`Unsupported payout currency: ${currency}`);
  process.exit(1);
}

const created = createBeneficiary(currency, address);

console.log();
console.log("Minewhile beneficiary created");
console.log("-----------------------------");
console.log(`Code:              ${created.beneficiary.id}`);
console.log(`Payout currency:   ${created.beneficiary.payoutCurrency}`);
console.log(`Payout address:    ${created.beneficiary.payoutAddress}`);
console.log();
console.log(`Referral parameter: ?r=${created.beneficiary.id}`);
console.log();
console.log("Management secret:");
console.log(created.managementSecret);
console.log();
console.log("SAVE THE MANAGEMENT SECRET.");
console.log("It cannot be recovered from the stored hash.");
