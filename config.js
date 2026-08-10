// ---------------------------------------------------------------------------
// config.js — tunable settings for the Revolution Realty bot.
// ---------------------------------------------------------------------------

export const config = {
  prefix: "!",
  brandName: "Revolution Realty",
  brandColor: 0x2b6cb0, // professional blue, used on embeds

  // --- Tickets --------------------------------------------------------------
  // Naming for the private deal channels (prefix + the customer's name).
  buyTicketPrefix: "buy-",
  sellTicketPrefix: "sell-",
  rentTicketPrefix: "rent-",
  renameTicketOnName: true,

  // The panel posted by !setup (and auto-setup).
  panelTitle: "🏠 Revolution Realty — Client Desk",
  panelDescription:
    "Welcome to Revolution Realty, your one-stop shop for everything property. " +
    "Pick an option below and a realtor will assist you.\n\n" +
    "🏠 **Buy a plot** — find and purchase a property.\n" +
    "💰 **Sell a plot** — list your property with us.\n" +
    "🔑 **Rent a plot** — rent an apartment or commercial space.\n" +
    "🛠️ **Become a Contractor** — partner with us to offer building services.\n" +
    "🔍 **Find Contractors** — browse our verified contractors.",

  // --- IGN verification -----------------------------------------------------
  // Users prove they own a Minecraft account by sending a tiny payment with a
  // unique memo to the firm's receiving account (VERIFY_ACCOUNT_ID), then
  // clicking confirm. Active only when DC_API_TOKEN + VERIFY_ACCOUNT_ID are set.
  verify: {
    amount: "0.01", // the micro-charge (decimal string)
    firmName: "RevolutionRealty", // firm that receives the payment
    setNicknameToIgn: true, // rename verified members to their IGN
    // Shown to the user. {firm}/{amount}/{memo} are filled in. Adjust to match
    // however payments are sent to your account on DemocracyCraft.
    payCommandTemplate: "/pay-account business {firm} {amount} {memo}",
    panelTitle: "🔐 Verify your account",
    panelDescription:
      "Before you can open a ticket, please verify the Minecraft account you'll " +
      "be dealing under. Click **Verify my IGN** below to get started — it takes " +
      "a single one-cent payment.",
  },

  // --- Contracts ------------------------------------------------------------
  contract: {
    commissionDefault: "10%",
    termDaysDefault: 30,
    paymentTermsDefault: "Full payment on transfer of the plot.",
    specialDefault: "None.",
    leaseTermDefault: "4 weeks",
    depositDefault: "None.",
  },

  // --- AutoMod / anti-spam --------------------------------------------------
  automod: {
    enabled: true, // create native Discord AutoMod rules on setup
    blockInvites: true, // block discord invite links (scam-server ads)
    mentionLimit: 6, // block messages mentioning more than this many users
    blockSpamPreset: true, // Discord's built-in spam detection
    // Bot-side raid guard: same message in >= N channels within the window →
    // delete + time the user out. Catches cross-channel ad raids.
    raidGuard: true,
    raidChannels: 3,
    raidWindowMs: 30000,
    raidTimeoutMins: 60,
  },

  // --- Contractors ----------------------------------------------------------
  contractor: {
    applyWelcome:
      "Thanks for your interest in partnering with **Revolution Realty**! " +
      "Tell us about your company — your services, examples of past work, and " +
      "your in-game name. A **manager** will review and approve you below.",
    channelTopic: "Partnered & verified contractors — find help to build or modify your plot.",
  },

  // --- Listings -------------------------------------------------------------
  // Forum channels created per category. Realtors post listings with /list.
  listingCategories: ["Residential", "Commercial", "Skyscraper", "Industrial"],
  listingTags: ["Sale", "Rent", "Sold"],

  // Shown at the top of each new ticket.
  buyWelcome:
    "Thanks for reaching out! A realtor will be with you shortly. To help us " +
    "get started, let us know **what you're looking for** — area, budget, plot " +
    "size, and any must-haves.",
  sellWelcome:
    "Thanks for choosing Revolution Realty to sell your plot! A realtor will be " +
    "with you shortly. To get started, share the **plot number (/gps)**, your " +
    "asking price, and anything we should know about the property.",
  rentWelcome:
    "Thanks for reaching out about renting! A realtor will be with you shortly. " +
    "Let us know what you're after — **apartment or commercial**, the area, your " +
    "weekly budget, and how long you'd like to rent for.",
};
