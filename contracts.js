// ---------------------------------------------------------------------------
// contracts.js — contract templates, the live signing embed, and PDF export.
// A contract object looks like:
//   { id, guild_id, channel_id, message_id, type:"seller"|"purchase",
//     status:"pending"|"signed"|"void", created_by, created_at,
//     fields:{...}, parties:[{ key, label, user_id, name, signed_at }] }
// ---------------------------------------------------------------------------
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} from "discord.js";
import PDFDocument from "pdfkit";
import { config } from "./config.js";

const COLOR_PENDING = 0xb7791f; // amber
const COLOR_SIGNED = 0x2f855a; // green
const COLOR_VOID = 0x718096; // grey

const ts = (ms) =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";

// --- Body templates (return an array of paragraph strings) -----------------
function sellerBody(f) {
  return [
    "**REVOLUTION REALTY — EXCLUSIVE LISTING AGREEMENT**",
    "",
    `**Effective date:** ${f.date}`,
    `**Term:** ${f.term_days} days (expires ${f.expiry_date})`,
    "",
    "**Parties**",
    `• Seller: ${f.seller} (IGN: ${f.seller_ign})`,
    `• Realtor: ${f.realtor} (IGN: ${f.realtor_ign}), for Revolution Realty (the "Firm")`,
    "",
    "**Property**",
    `• Plot: ${f.plot}`,
    `• Description: ${f.plot_desc}`,
    `• Listing price: ${f.price}`,
    "",
    "**Terms & Conditions**",
    "1. Appointment. The Seller appoints the Realtor and the Firm as their exclusive representative to market and sell the Property for the Term.",
    "2. Realtor duties. The Realtor will advertise the Property, find buyers, present offers, and facilitate the transfer in good faith.",
    "3. Seller duties. The Seller will cooperate, provide accurate information, and not list the Property with another firm during the Term.",
    `4. Commission. On a completed sale, the Seller pays the Firm a commission of ${f.commission} of the final sale price.`,
    `5. Protection clause. If the Property is sold or transferred during the Term — including by the Seller directly, without the Realtor — the Firm remains entitled to the full commission. This also applies to a sale within ${f.term_days} days of expiry to a buyer introduced by the Realtor.`,
    `6. Term. This Agreement runs ${f.term_days} days from the Effective date, then expires unless renewed in writing.`,
    "7. Entire agreement. Changes must be agreed by both parties here and re-signed.",
  ];
}

function purchaseBody(f) {
  return [
    "**REVOLUTION REALTY — PURCHASE AGREEMENT**",
    "",
    `**Effective date:** ${f.date}`,
    "",
    "**Parties**",
    `• Buyer: ${f.buyer} (IGN: ${f.buyer_ign})`,
    `• Seller: ${f.seller} (IGN: ${f.seller_ign})`,
    `• Realtor / Intermediary: ${f.realtor} (IGN: ${f.realtor_ign}), of Revolution Realty`,
    "",
    "**Property**",
    `• Plot: ${f.plot}`,
    `• Description: ${f.plot_desc}`,
    `• Purchase price: ${f.price}`,
    "",
    "**Terms & Conditions**",
    "1. Sale. The Seller agrees to sell, and the Buyer agrees to buy, the Property at the Purchase price, with Revolution Realty acting as intermediary.",
    `2. Payment. The Buyer shall pay the Purchase price as follows: ${f.payment_terms}`,
    `3. Special requirements. ${f.special}`,
    "4. Transfer. On confirmed payment, the Seller will transfer plot ownership to the Buyer, and the Realtor will confirm completion here.",
    `5. Commission. The Firm's commission of ${f.commission} is settled as part of this transaction (per the relevant Listing Agreement, where applicable).`,
    "6. Good faith. All parties agree to complete the transaction honestly and per DemocracyCraft rules. Disputes go to Firm management.",
    "7. Entire agreement. Changes must be agreed by all parties here and re-signed.",
  ];
}

function leaseBody(f) {
  return [
    "**REVOLUTION REALTY — LEASE / RENTAL AGREEMENT**",
    "",
    `**Effective date:** ${f.date}`,
    `**Term:** ${f.term}`,
    "",
    "**Parties**",
    `• Landlord: ${f.landlord} (IGN: ${f.landlord_ign})`,
    `• Tenant: ${f.tenant} (IGN: ${f.tenant_ign})`,
    `• Realtor: ${f.realtor} (IGN: ${f.realtor_ign}), of Revolution Realty`,
    "",
    "**Property**",
    `• Plot: ${f.plot}`,
    `• Description: ${f.plot_desc}`,
    `• Rent: ${f.rent}/week`,
    `• Security deposit: ${f.deposit}`,
    "",
    "**Terms & Conditions**",
    "1. Lease. The Landlord leases the Property to the Tenant for the Term at the stated Rent.",
    `2. Rent. The Tenant shall pay ${f.rent}/week for the duration of the Term. Repeated late or missed payments may end the lease.`,
    `3. Deposit. The Tenant pays a security deposit of ${f.deposit}, refundable at the end of the Term less any damages or unpaid rent.`,
    "4. Use. The Tenant will use the Property responsibly and per DemocracyCraft rules, with no unauthorised building changes without the Landlord's consent.",
    `5. Commission. Revolution Realty's commission of ${f.commission} applies per the arrangement with the Landlord.`,
    "6. Termination. The lease expires at the end of the Term unless renewed in writing; either party may end it early per agreed terms.",
    `7. Special requirements. ${f.special}`,
    "8. Entire agreement. Changes must be agreed by all parties here and re-signed.",
  ];
}

function bodyLines(contract) {
  if (contract.type === "seller") return sellerBody(contract.fields);
  if (contract.type === "lease") return leaseBody(contract.fields);
  return purchaseBody(contract.fields);
}

function signatureLines(contract) {
  return contract.parties.map((p) =>
    p.signed_at
      ? `✅ ${p.label} — ${p.name}: signed ${ts(p.signed_at)}`
      : `⬜ ${p.label} — ${p.name}: awaiting signature`
  );
}

export function allSigned(contract) {
  return contract.parties.every((p) => p.signed_at);
}

// --- The live signing embed + buttons --------------------------------------
export function contractEmbed(contract) {
  const statusLabel =
    contract.status === "signed"
      ? "✅ FULLY SIGNED"
      : contract.status === "void"
      ? "🚫 VOID"
      : "🖊️ Awaiting signatures";
  const color =
    contract.status === "signed"
      ? COLOR_SIGNED
      : contract.status === "void"
      ? COLOR_VOID
      : COLOR_PENDING;

  const body = bodyLines(contract).join("\n");
  const sigs = signatureLines(contract).join("\n");

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Contract #${contract.id} — ${statusLabel}`)
    .setDescription(body.slice(0, 4000))
    .addFields({ name: "✍️ Signatures", value: sigs })
    .setFooter({ text: `${config.brandName} • click Sign below to add your signature` });
}

export function contractButtons(contract) {
  const disabled = contract.status !== "pending";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`contract_sign_${contract.id}`)
      .setLabel("Sign")
      .setEmoji("🖊️")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`contract_void_${contract.id}`)
      .setLabel("Void")
      .setEmoji("🚫")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

// --- PDF export ------------------------------------------------------------
const noMarkdown = (s) => s.replace(/\*\*/g, "");
const noEmoji = (s) =>
  s.replace("✅", "[SIGNED]").replace("⬜", "[ ]");

export function buildPdf(contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "A4" });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("REVOLUTION REALTY", { align: "center" });
    doc
      .fontSize(10)
      .fillColor("#666")
      .text(`Contract #${contract.id}`, { align: "center" });
    doc.moveDown().fillColor("#000");

    doc.fontSize(11);
    for (const line of bodyLines(contract)) {
      if (line === "") doc.moveDown(0.4);
      else doc.text(noMarkdown(line), { paragraphGap: 2 });
    }

    doc.moveDown().fontSize(12).text("Signatures", { underline: true });
    doc.fontSize(11);
    for (const line of signatureLines(contract)) doc.text(noEmoji(line));

    doc.moveDown(2).fontSize(8).fillColor("#888");
    doc.text(
      `Generated by ${config.brandName} on ${ts(Date.now())}. ` +
        "This is an in-character agreement for DemocracyCraft.",
      { align: "center" }
    );
    doc.end();
  });
}

export async function pdfAttachment(contract) {
  const buf = await buildPdf(contract);
  const safe =
    contract.type === "seller"
      ? "listing-agreement"
      : contract.type === "lease"
      ? "lease-agreement"
      : "purchase-agreement";
  return new AttachmentBuilder(buf, {
    name: `${safe}-contract-${contract.id}.pdf`,
  });
}

// --- Field builders (used by the slash command handlers) -------------------
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function plusDaysISO(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
