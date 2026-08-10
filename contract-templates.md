# Revolution Realty — Contract Templates (DRAFT for review)

These are in-character agreements for use on DemocracyCraft. `{{fields}}` are
filled in automatically by the bot when a realtor issues the contract; the
**signature blocks** are stamped by the bot when each party clicks **Sign**
(username + UTC timestamp). Enforcement is per DemocracyCraft server rules.

Reviewers: edit any wording, clause, or default value below and I'll match it
exactly when I build the signing flow.

---

## 1. Seller's (Listing) Agreement

**REVOLUTION REALTY — EXCLUSIVE LISTING AGREEMENT**

**Effective date:** {{date}}
**Term:** {{term_days}} days (expires {{expiry_date}})

**Parties**
- **Seller:** {{seller}} (IGN: {{seller_ign}})
- **Realtor:** {{realtor}} (IGN: {{realtor_ign}}), representing **Revolution Realty** (the "Firm")

**Property**
- **Plot:** {{plot}}
- **Location / description:** {{plot_desc}}
- **Listing price:** {{price}}

**Terms & Conditions**

1. **Appointment.** The Seller appoints the Realtor and the Firm as their
   **exclusive** representative to market and sell the Property for the Term.
2. **Realtor duties.** The Realtor will advertise the Property, find prospective
   buyers, present offers, and facilitate the transfer in good faith.
3. **Seller duties.** The Seller will cooperate with the Realtor, provide
   accurate information about the Property, and not grant a competing listing to
   another firm during the Term.
4. **Commission.** Upon a completed sale of the Property, the Seller shall pay
   the Firm a commission of **{{commission}}** of the final sale price.
5. **Protection clause.** If the Property is sold, transferred, or otherwise
   disposed of **during the Term — including by the Seller directly, without the
   Realtor's involvement** — the Firm remains entitled to the full commission in
   clause 4. This also applies to any sale within {{term_days}} days of expiry
   to a buyer introduced by the Realtor.
6. **Term & termination.** This Agreement runs for {{term_days}} days from the
   Effective date and then expires automatically unless renewed in writing.
7. **Entire agreement.** Any changes must be agreed by both parties in this
   channel and re-signed.

**Signatures** *(stamped on click-to-sign)*

- Seller — {{seller}}: ____________________  Signed: ____________________
- Realtor — {{realtor}}: __________________  Signed: ____________________

---

## 2. Purchase Agreement

**REVOLUTION REALTY — PURCHASE AGREEMENT**

**Effective date:** {{date}}

**Parties**
- **Buyer:** {{buyer}} (IGN: {{buyer_ign}})
- **Seller:** {{seller}} (IGN: {{seller_ign}})
- **Realtor / Intermediary:** {{realtor}} (IGN: {{realtor_ign}}), of **Revolution Realty**

**Property**
- **Plot:** {{plot}}
- **Location / description:** {{plot_desc}}
- **Purchase price:** {{price}}

**Terms & Conditions**

1. **Sale.** The Seller agrees to sell, and the Buyer agrees to buy, the
   Property at the Purchase price, with Revolution Realty acting as the
   intermediary handling the transaction.
2. **Payment.** The Buyer shall pay the Purchase price as follows:
   {{payment_terms}}. Funds are handled through the agreed DemocracyCraft method.
3. **Special requirements.** {{special}}
4. **Transfer.** On confirmed payment, the Seller will transfer plot ownership of
   the Property to the Buyer, and the Realtor will confirm completion here.
5. **Commission.** The Firm's commission of **{{commission}}** is settled as part
   of this transaction (per the relevant Listing Agreement, where applicable).
6. **Good faith.** All parties agree to complete the transaction honestly and
   per DemocracyCraft rules. Disputes are raised with Firm management.
7. **Entire agreement.** Any changes must be agreed by all parties in this
   channel and re-signed.

**Signatures** *(stamped on click-to-sign — all three required to finalize)*

- Buyer — {{buyer}}: _____________________  Signed: ____________________
- Seller — {{seller}}: ___________________  Signed: ____________________
- Realtor — {{realtor}}: _________________  Signed: ____________________

---

### Default values I assumed (change any)

| Field | Default | Notes |
|---|---|---|
| `{{term_days}}` | 30 | Listing term length |
| `{{commission}}` | 10% | Firm commission rate |
| `{{payment_terms}}` | "Full payment on transfer" | Or staged, e.g. deposit + balance |
| Purchase signers | Buyer + Seller + Realtor (all 3) | Seller's needs Seller + Realtor |
