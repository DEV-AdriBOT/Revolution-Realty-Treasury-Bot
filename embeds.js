// ---------------------------------------------------------------------------
// embeds.js — Revolution Realty embeds and the ticket-panel buttons.
// ---------------------------------------------------------------------------
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { config } from "./config.js";

// The public panel with Buy / Sell buttons.
export function panelEmbed() {
  return new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(config.panelTitle)
    .setDescription(config.panelDescription);
}

export function panelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_buy")
      .setLabel("Buy a plot")
      .setEmoji("🏠")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket_sell")
      .setLabel("Sell a plot")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ticket_rent")
      .setLabel("Rent a plot")
      .setEmoji("🔑")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("ticket_contractor")
      .setLabel("Become a Contractor")
      .setEmoji("🛠️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("find_contractors")
      .setLabel("Find Contractors")
      .setEmoji("🔍")
      .setStyle(ButtonStyle.Secondary)
  );
}

// --- Contractors ------------------------------------------------------------
export function contractorWelcomeEmbed() {
  return new EmbedBuilder()
    .setColor(0xdd6b20)
    .setTitle("🛠️ Contractor application")
    .setDescription(config.contractor.applyWelcome)
    .addFields({
      name: "📋 How this works",
      value: [
        "**1️⃣ Introduce your company** — services, past work, and your in-game name.",
        "**2️⃣ A manager reviews** — they'll click **✅ Approve** or **❌ Deny** below.",
        "**3️⃣ Approved!** — you get the **Contractor** role.",
        "**4️⃣ Advertise** — run **`/contractor-ad`** to post your company in the contractors channel.",
      ].join("\n\n"),
    })
    .setFooter({ text: `${config.brandName} • a manager will review your application` });
}

export function contractorReviewButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("contractor_approve")
      .setLabel("Approve")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("contractor_deny")
      .setLabel("Deny")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
  );
}

export function contractorAdEmbed({ company, services, contact, image_name, by }) {
  const e = new EmbedBuilder()
    .setColor(0xdd6b20)
    .setTitle(`🛠️ ${company}`)
    .setDescription(services)
    .setFooter({ text: `${config.brandName} • verified contractor • posted by ${by}` });
  if (contact) e.addFields({ name: "Contact", value: contact });
  if (image_name) e.setImage(`attachment://${image_name}`);
  return e;
}

// The welcome message inside a freshly opened ticket — lays out the whole
// process so the client knows exactly what to expect, start to finish.
export function ticketWelcomeEmbed(type) {
  const map = {
    buy: {
      title: "🏠 Buying a plot",
      intro: config.buyWelcome,
      steps: [
        "**1️⃣ Tell us what you want** — area, budget, plot size, must-haves.",
        "**2️⃣ We find it** — your realtor shows you matching plots and listings.",
        "**3️⃣ Sign** — your realtor sends a **Purchase Agreement**; you (and the seller) click **Sign** on it.",
        "**4️⃣ Pay** — a payment panel appears here. Click **💳 Get pay command**, pay the firm in-game (you can pay in installments), then click **✅ Check payment**. Lost the panel? Just run **`/pay`**.",
        "**5️⃣ Done** — once it's paid in full, the realtor transfers the plot to you and finalizes the deal.",
      ],
    },
    sell: {
      title: "💰 Selling a plot",
      intro: config.sellWelcome,
      steps: [
        "**1️⃣ Share your plot** — the plot number (`/gps`), your asking price, and any details.",
        "**2️⃣ Sign the listing** — your realtor sends a **Seller's Agreement**; you and the realtor **Sign**. (Heads-up: the firm earns commission even if you sell it yourself during the term.)",
        "**3️⃣ We list it** — your plot goes into our public listings for buyers to browse.",
        "**4️⃣ Buyer found** — when there's a buyer, a **Purchase Agreement** is signed and they pay the firm.",
        "**5️⃣ Get paid** — on completion you **automatically receive your proceeds** (price − commission) in-game.",
      ],
    },
    rent: {
      title: "🔑 Renting a plot",
      intro: config.rentWelcome,
      steps: [
        "**1️⃣ Tell us what you want** — apartment or commercial, area, weekly budget, how long.",
        "**2️⃣ Sign the lease** — your realtor sends a **Lease Agreement**; the landlord, you (tenant), and the realtor all **Sign**.",
        "**3️⃣ Pay weekly rent** — each week a panel appears here. **💳 Get pay command** → pay the firm → **✅ Check payment**. Use **`/pay`** anytime to get it again.",
        "**4️⃣ It repeats** — rent reminders continue weekly until your lease term ends.",
      ],
    },
  };
  const t = map[type] ?? map.buy;
  return new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(t.title)
    .setDescription(t.intro)
    .addFields({ name: "📋 How this works", value: t.steps.join("\n\n") })
    .setFooter({ text: `${config.brandName} • a realtor will be with you shortly` });
}

export function closeButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
}

// --- Payment panels ---------------------------------------------------------
export function paymentPanelEmbed(contract, { amount, weekly, week }) {
  const plot = contract.fields.plot;
  const e = new EmbedBuilder().setColor(weekly ? 0x38a169 : config.brandColor);
  const steps =
    "**1️⃣** Click **💳 Get pay command** below — I'll DM you the exact in-game command with your **unique memo**.\n" +
    "**2️⃣** Run it in-game to pay the firm.\n" +
    "**3️⃣** Click **✅ Check payment** to confirm.\n\n" +
    "💡 You can pay in **installments** — Check payment shows how much is left. Lost this panel? Run **`/pay`**.";
  if (weekly) {
    e.setTitle(`🔑 Weekly rent due — Week ${week}`).setDescription(
      `Your rent of **${amount}/week** for plot **${plot}** is due.\n\n${steps}`
    );
  } else {
    e.setTitle("💳 Payment due").setDescription(
      `To complete your purchase of plot **${plot}**, pay the firm **${amount}**.\n\n${steps}`
    );
  }
  return e.setFooter({ text: `${config.brandName} • Contract #${contract.id}` });
}

export function paymentPanelButtons(contract) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pay_cmd_${contract.id}`)
      .setLabel("Get pay command")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`pay_check_${contract.id}`)
      .setLabel("Check payment")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );
}

// --- Help -------------------------------------------------------------------
export function helpEmbed(isStaff, verifyOn) {
  const e = new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(`${config.brandName} — Help`)
    .setDescription("Your one-stop shop for buying, selling, and renting plots.");

  const client = [
    "• Open a ticket from the **Client Desk** — **Buy a plot** or **Sell a plot** — and a realtor will assist you.",
    "• Browse current listings in the **Residential / Commercial / Skyscraper / Industrial** forums.",
    "• After a contract is signed, use the **payment panel** in your ticket: **Get pay command** → pay in-game → **Check payment**. Lost the panel? Run **`/pay`** in your ticket to get your pay command again.",
    "• Need a builder? **Find Contractors** on the Client Desk. Run a building company? **Become a Contractor** → once approved, post ads with `/contractor-ad`.",
  ];
  if (verifyOn) {
    client.push("• Verify your Minecraft account in the **verify** channel to unlock the Client Desk.");
  }
  e.addFields({ name: "🏠 For clients", value: client.join("\n") });

  if (isStaff) {
    e.addFields({
      name: "💼 For realtors & managers",
      value: [
        "`/panel` — your control panel with everything you can do",
        "`/seller-agreement` — issue an exclusive listing agreement",
        "`/purchase-agreement` — issue a purchase agreement",
        "`/lease-agreement` — issue a lease / rental agreement",
        "`/complete-deal contract:<id>` — confirm transfer → release escrow + commission",
        "`/list` — post a plot listing to a category forum",
        "`/contracts` / `/contract id:<id>` — look up past contracts",
        "`/close` — close a ticket",
        "`/setup` / `/resetup` — (admin) post the panel / re-provision",
      ].join("\n"),
    });
  }
  return e;
}

// --- Staff control panel (/panel) -------------------------------------------
export function staffPanelEmbed(manager) {
  const e = new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(`💼 ${config.brandName} — ${manager ? "Manager" : "Realtor"} Panel`)
    .setDescription("Everything you can do, in one place.")
    .addFields(
      {
        name: "📄 Contracts (use in a ticket)",
        value: [
          "`/seller-agreement` — exclusive listing agreement",
          "`/purchase-agreement` — purchase agreement",
          "`/lease-agreement` — lease / rental agreement",
        ].join("\n"),
      },
      {
        name: "💸 Deals & listings",
        value: [
          "`/complete-deal contract:<id>` — release escrow + commission on a sale",
          "`/list` — post a plot listing to a category forum",
          "`/contracts` / `/contract id:<id>` — look up past contracts",
        ].join("\n"),
      }
    );
  if (manager) {
    e.addFields({
      name: "🛠️ Manager only",
      value: [
        "Approve/deny contractors in their application tickets",
        "`/setup` / `/resetup` — post the client panel / re-provision",
        "Buttons below: re-post the client panel, view recent contracts",
      ].join("\n"),
    });
  }
  return e.setFooter({ text: `${config.brandName}` });
}

export function staffPanelButtons(manager) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("panel_contracts")
      .setLabel("Recent contracts")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Secondary)
  );
  if (manager) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId("panel_postdesk")
        .setLabel("Post client panel here")
        .setEmoji("📢")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  return row;
}

// --- Listings ---------------------------------------------------------------
export function listingEmbed(listing) {
  const e = new EmbedBuilder()
    .setColor(listing.type === "Rent" ? 0x38a169 : config.brandColor)
    .setTitle(`${listing.type === "Rent" ? "🔑" : "🏷️"} ${listing.title}`)
    .addFields(
      { name: "Category", value: listing.category, inline: true },
      { name: "Type", value: `For ${listing.type}`, inline: true },
      { name: "Plot", value: listing.plot, inline: true },
      { name: "Price", value: listing.price, inline: true }
    )
    .setFooter({ text: `${config.brandName} • Listing #${listing.id} • posted by ${listing.realtor}` });
  if (listing.description && listing.description !== "—") {
    e.setDescription(listing.description);
  }
  if (listing.image_name) e.setImage(`attachment://${listing.image_name}`);
  return e;
}

// --- IGN verification panel -------------------------------------------------
export function verifyPanelEmbed() {
  return new EmbedBuilder()
    .setColor(config.brandColor)
    .setTitle(config.verify.panelTitle)
    .setDescription(config.verify.panelDescription);
}

export function verifyPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_start")
      .setLabel("Verify my IGN")
      .setEmoji("🔐")
      .setStyle(ButtonStyle.Primary)
  );
}

// The "I've sent it" confirm button shown after instructions.
export function verifyConfirmButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_check")
      .setLabel("I've sent it")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );
}
