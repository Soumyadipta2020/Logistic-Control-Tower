export interface KPIDef {
  meaning: string
  howCalculated: string
  benchmark?: string
}

// Keyed by both API snake_case keys AND display label strings so lookups work
// from both KPICard (label prop) and inline InfoTooltip usage.
export const KPI_DEFINITIONS: Record<string, KPIDef> = {

  // ── Transport Control ──────────────────────────────────────────────────────
  "Walkaround Compliance": {
    meaning: "Percentage of active vans whose DVSA daily walkaround check was completed and logged before the first job of the day.",
    howCalculated: "Vans with a signed-off digital walkaround today ÷ total active vans × 100. Checks are timestamped and geolocated for audit evidence.",
    benchmark: "DVSA expects a documented daily check on every commercial vehicle. Target ≥95%; each missed check is an enforcement risk.",
  },
  "VOR": {
    meaning: "Vehicles Off Road — vans withdrawn from service due to an unresolved major defect, MOT lapse, or accident damage.",
    howCalculated: "Count of fleet vehicles flagged VOR. A van is auto-flagged when a major safety defect is reported and un-flagged when all major defects are resolved.",
    benchmark: "Best-in-class UK van fleets hold VOR below 3% of the fleet. Every VOR van reduces same-day field capacity by ~5 jobs.",
  },
  "CAZ Non-Compliant": {
    meaning: "Vans that do not meet Clean Air Zone emission standards (Euro 6 diesel / Euro 4 petrol / EV) and incur daily charges when entering UK CAZ, ULEZ or LEZ areas.",
    howCalculated: "Count of vehicles with Euro 5 or older diesel engines. London ULEZ charges £12.50/day; Scottish LEZs issue £60 penalties.",
    benchmark: "Zero is the target — route non-compliant vans away from zones or prioritise them for EV replacement.",
  },
  "Driver Score": {
    meaning: "Composite telematics score (0–100) for each driver based on harsh braking, harsh acceleration, speeding events and engine idling over the last 7 days.",
    howCalculated: "Weighted deduction model from a base of 100: −2 per harsh braking event, −4 per speeding event, −0.5 per % of idling time.",
    benchmark: "≥85 Green, 70–84 Amber (monitor), <70 Red — triggers a coaching conversation. Fleet average ≥82 correlates with lower insurance premiums.",
  },
  "EV Fleet": {
    meaning: "Percentage of the van fleet that is fully electric — key to CAZ exemption, Scope 1 emission reduction and lower running costs.",
    howCalculated: "EV vans ÷ total fleet × 100.",
    benchmark: "UK ZEV mandate pushes new van sales to zero-emission by 2035. Leading utility fleets target 30% EV by 2027.",
  },
  "Open Defects": {
    meaning: "Vehicle faults reported through the digital walkaround or by the workshop that have not yet been rectified.",
    howCalculated: "Count of open defect records across the fleet. Major safety defects (brakes, tyres, steering) automatically flag the vehicle VOR.",
    benchmark: "Minor defects should be rectified within 7 days; major defects before the vehicle's next journey — this is a DVSA roadworthiness requirement.",
  },
  "Miles Avoided": {
    meaning: "Total driving miles removed from today's engineer routes by AI re-sequencing of job visits.",
    howCalculated: "Σ (planned route miles − optimized route miles) across all optimized routes.",
    benchmark: "Fewer miles = lower fuel spend, less CO₂ and reduced vehicle wear. 800+ miles/day avoided across a 200-van fleet is typical for dynamic routing.",
  },
  "Travel Time Saved": {
    meaning: "Engineer driving time removed today by AI route re-sequencing — visits reordered so each engineer drives the shortest practical path between jobs.",
    howCalculated: "Σ (planned travel minutes − optimized travel minutes) across all optimized routes. Typical savings are 8–18% of planned drive time.",
    benchmark: "Every 45 minutes saved is roughly one extra job slot per engineer per week.",
  },
  "Fuel Saved": {
    meaning: "Fuel (or charging) cost avoided today through route optimization — fewer miles driven means less diesel burned and lower CAZ exposure.",
    howCalculated: "Miles avoided × pence-per-mile by fuel type (diesel ~18p/mi, EV ~7p/mi).",
    benchmark: "UK fleets adopting dynamic routing typically report 10–15% annual fuel cost reduction.",
  },
  "CO₂ Avoided": {
    meaning: "Tailpipe CO₂ not emitted today because optimized routes cut diesel miles.",
    howCalculated: "Diesel miles avoided × 0.28 kg CO₂/mile. EV miles avoided save cost but no tailpipe CO₂.",
    benchmark: "Feeds directly into the Scope 1 reduction pathway alongside EV transition.",
  },
  "MOT Due 30d": {
    meaning: "Vans whose MOT certificate expires within the next 30 days. Driving without a valid MOT invalidates insurance and risks a £1,000 fine.",
    howCalculated: "Count of vehicles where MOT expiry date − today ≤ 30 days.",
    benchmark: "Book MOT slots at least 2 weeks ahead; vans overdue by 0 days should be VOR immediately.",
  },

  // ── Inventory / Demand ─────────────────────────────────────────────────────
  "On Hand": {
    meaning: "Total physical units of this SKU currently at the warehouse, regardless of whether they are allocated to an order or a job.",
    howCalculated: "Sum of all units in all warehouse locations (pick faces, bulk, quarantine) for this SKU.",
    benchmark: "On Hand ≥ Reorder Point means no replenishment action is needed yet.",
  },
  "Reserved": {
    meaning: "Units already allocated to open field jobs, active replenishment orders, or van-stock picks that have not yet left the warehouse.",
    howCalculated: "Count of units with an active allocation record in the WMS against open orders.",
    benchmark: "High reserved vs on-hand ratio means net available is low — watch for over-commitment risk.",
  },
  "Available": {
    meaning: "Net units immediately available for new job allocations. The number that matters for same-day fulfilment decisions.",
    howCalculated: "Available = On Hand − Reserved. A negative value would indicate over-allocation (critical).",
    benchmark: "Available must stay above Safety Stock to maintain a buffer against demand spikes.",
  },
  "Safety Stock": {
    meaning: "The minimum buffer inventory kept to absorb demand variability or supply delays without causing a stockout. Set using statistical demand modelling.",
    howCalculated: "Safety Stock = Z × σ_demand × √Lead Time, where Z is the service-level z-score (typically 1.65 for 95% service level).",
    benchmark: "If Available falls below Safety Stock the RAG status moves to Amber — replenishment should be initiated.",
  },
  "Reorder Pt": {
    meaning: "The stock level that triggers a replenishment order. When On Hand drops to or below this point, a PO must be raised to avoid a stockout.",
    howCalculated: "Reorder Point = (Average daily demand × Lead Time days) + Safety Stock.",
    benchmark: "An On Hand at or below Reorder Point means a PO is overdue. System will auto-flag for action.",
  },
  "Days Cover": {
    meaning: "How many days of demand the current available stock can cover at the current rate of consumption. The primary urgency indicator.",
    howCalculated: "Days Cover = Available ÷ Adjusted daily consumption rate (weather-uplift applied).",
    benchmark: "Days Cover < Lead Time = Red (stockout before replenishment can arrive). < Lead Time + Review = Amber. ≥ both = Green.",
  },
  "Lead Time": {
    meaning: "The number of calendar days between raising a purchase order with the supplier and the stock arriving at the warehouse and being available to pick.",
    howCalculated: "Sourced from the supplier master and updated after each actual PO delivery. Includes transport and goods-in processing time.",
    benchmark: "Lead time directly sets the Reorder Point — longer lead times require more stock to be held.",
  },
  "Stock Status": {
    meaning: "RAG (Red / Amber / Green) status summarising whether this SKU is at risk of a stockout before the next replenishment can arrive.",
    howCalculated: "Green: Days Cover ≥ Lead Time + Review Period AND Available ≥ Safety Stock. Amber: partially below thresholds. Red: Days Cover < Lead Time or zero available stock.",
    benchmark: "All SKUs should be Green. Amber requires a PO to be raised within 24h. Red requires an emergency PO today.",
  },
  "Segment": {
    meaning: "ABC/XYZ planning segment. The letter grades value and predictability: A/B/C ranks the SKU's annual consumption value (A = top 80% of spend), X/Y/Z ranks demand predictability (X = stable, Z = volatile).",
    howCalculated: "ABC: rank SKUs by annual value (daily demand × 365 × unit cost) and cut at 80% / 95% cumulative share. XYZ: coefficient of variation of weekly demand — X ≤ 0.25, Y ≤ 0.50, Z > 0.50.",
    benchmark: "Each segment carries a differentiated service-level target: A items ≥98%, X items can run leaner buffers, Z items need extra safety stock. AZ items (high value, volatile) get planner attention first.",
  },
  "Stock Value": {
    meaning: "Working capital tied up in this SKU's on-hand stock — the number finance sees. High-value SKUs justify tighter planning even at low volumes.",
    howCalculated: "Units on hand × unit cost (£).",
    benchmark: "Watch the EXCESS tag: stock above ~125% of the order-up-to target is capital that could be released or rebalanced.",
  },
  "Action Value": {
    meaning: "The order value of this recommendation at unit cost — used to rank actions by financial impact, so the biggest £ exposures are dealt with first.",
    howCalculated: "Recommended quantity × unit cost (£).",
    benchmark: "Critical actions are ranked first, then by £ value within the same priority.",
  },
  "Site Health": {
    meaning: "Per-site RAG dots for this SKU across the two-echelon network: the Leicester NDC (replenished from suppliers) and the Coventry, Manchester and Cardiff regional hubs (replenished from the NDC by trunker transfer).",
    howCalculated: "Each site's RAG is computed against its own replenishment horizon — supplier lead time at the NDC, trunker transfer lead time at hubs. Hover a dot for that site's position.",
    benchmark: "A red hub with a green NDC is fixed by an internal transfer, not a supplier PO. A red NDC needs supplier action.",
  },
  "Transfer Lead": {
    meaning: "The number of days for an internal trunker transfer to move stock from the Leicester NDC to this regional hub, including pick, load and goods-in at the hub.",
    howCalculated: "Fixed per trunker lane: Coventry and Manchester 1 day, Cardiff 2 days.",
    benchmark: "Because transfer leads are short, hubs can run leaner buffers — the strategic stock sits at the NDC.",
  },
  "Transfer ETA": {
    meaning: "Expected arrival of this stock transfer order (STO) at the destination hub.",
    howCalculated: "Dispatch time + the lane's trunker transfer lead time.",
    benchmark: "Overdue transfers put the destination hub's days of cover at risk — chase with the 3PL transport desk.",
  },
  "PO Type": {
    meaning: "Classification of the purchase order. Standard orders follow normal lead times; Emergency orders are expedited (courier or same-day) at a freight premium; Auto orders are system-generated by the demand model.",
    howCalculated: "Set at PO creation — either by the planner or by the automated replenishment engine.",
    benchmark: "Emergency POs should be <5% of total PO volume. Higher rates signal a forecasting or supply chain issue.",
  },
  "Value (£)": {
    meaning: "Total sterling value of this purchase order: unit cost × ordered quantity, exclusive of VAT and delivery charges.",
    howCalculated: "Unit cost from the Ariba contract price schedule × quantity ordered.",
    benchmark: "Emergency POs typically carry 20–40% freight premium on top of standard cost.",
  },
  "Delivery": {
    meaning: "Days remaining until the supplier's committed delivery date for this purchase order. Negative values indicate the PO is overdue.",
    howCalculated: "Expected delivery date − today. Sourced from the supplier's confirmed delivery commitment at PO acceptance.",
    benchmark: "0 = due today. Negative = overdue (escalate). > 10d = within normal lead time.",
  },
  "Open POs": {
    meaning: "Total count of purchase orders currently in open status — confirmed, in-transit, or awaiting delivery. Indicates active procurement pipeline.",
    howCalculated: "Count of POs with status ∈ {confirmed, in_transit, draft} excluding cancelled and received.",
    benchmark: "Volume tracks with demand signal. Unusually high count may indicate receiving delays.",
  },
  "OTIF %": {
    meaning: "On-Time-In-Full delivery rate for this OEM supplier — the percentage of their POs delivered on the agreed date and in the correct quantity.",
    howCalculated: "POs from this supplier delivered on time AND in full ÷ total POs from this supplier × 100.",
    benchmark: "Target: >92%. Below 80% triggers a supplier review and may require safety stock uplift.",
  },
  "Next HGV": {
    meaning: "Date of the next scheduled Heavy Goods Vehicle delivery slot booked with this OEM supplier. Heat pump units ship in full HGV loads due to size and weight.",
    howCalculated: "Sourced from the logistics booking system — the next confirmed collection/delivery appointment.",
    benchmark: "If the next HGV slot is beyond the projected stockout date, an emergency courier order may be needed.",
  },

  // ── Field / Service ────────────────────────────────────────────────────────
  first_time_fix_rate: {
    meaning: "Percentage of engineer jobs completed successfully on the very first visit, without a return trip.",
    howCalculated: "Jobs closed on first visit ÷ total jobs dispatched × 100.",
    benchmark: "Industry benchmark: >85%. ABC target: 82%.",
  },
  "first time fix rate": {
    meaning: "Percentage of engineer jobs completed successfully on the very first visit, without a return trip.",
    howCalculated: "Jobs closed on first visit ÷ total jobs dispatched × 100.",
    benchmark: "Industry benchmark: >85%. ABC target: 82%.",
  },
  "First Time Fix Rate": {
    meaning: "Percentage of engineer jobs completed successfully on the very first visit, without a return trip.",
    howCalculated: "Jobs closed on first visit ÷ total jobs dispatched × 100.",
    benchmark: "Industry benchmark: >85%. ABC target: 82%.",
  },

  sla_compliance_rate: {
    meaning: "Percentage of service jobs completed within the contracted SLA window. Breaches expose ABC to financial penalties and customer churn.",
    howCalculated: "Jobs completed within SLA commitment time ÷ total jobs × 100.",
    benchmark: "Contractual minimum: 95%. Target: 98%. Each 1% drop ≈ £120k annual penalty exposure.",
  },
  "sla compliance rate": {
    meaning: "Percentage of service jobs completed within the contracted SLA window. Breaches expose ABC to financial penalties and customer churn.",
    howCalculated: "Jobs completed within SLA commitment time ÷ total jobs × 100.",
    benchmark: "Contractual minimum: 95%. Target: 98%. Each 1% drop ≈ £120k annual penalty exposure.",
  },
  "SLA Compliance": {
    meaning: "Percentage of service jobs completed within the contracted SLA window. Breaches expose ABC to financial penalties and customer churn.",
    howCalculated: "Jobs completed within SLA commitment time ÷ total jobs × 100.",
    benchmark: "Contractual minimum: 95%. Target: 98%. Each 1% drop ≈ £120k annual penalty exposure.",
  },

  csat_score: {
    meaning: "Average customer satisfaction rating collected via post-visit survey. Directly tracks customer experience and likelihood of contract renewal.",
    howCalculated: "Sum of ratings (1–5 scale) from post-visit surveys ÷ number of responses.",
    benchmark: "Good: ≥4.0. Excellent: ≥4.5. ABC target: 4.5/5.",
  },
  "csat score": {
    meaning: "Average customer satisfaction rating collected via post-visit survey. Directly tracks customer experience and likelihood of contract renewal.",
    howCalculated: "Sum of ratings (1–5 scale) from post-visit surveys ÷ number of responses.",
    benchmark: "Good: ≥4.0. Excellent: ≥4.5. ABC target: 4.5/5.",
  },
  "Customer CSAT": {
    meaning: "Average customer satisfaction rating collected via post-visit survey. Directly tracks customer experience and likelihood of contract renewal.",
    howCalculated: "Sum of ratings (1–5 scale) from post-visit surveys ÷ number of responses.",
    benchmark: "Good: ≥4.0. Excellent: ≥4.5. ABC target: 4.5/5.",
  },

  pre_8am_delivery_success: {
    meaning: "Percentage of ByBox smart locker deliveries completed before 08:00, so engineers collect parts before their first job.",
    howCalculated: "Locker deliveries confirmed by 07:59 ÷ total scheduled pre-8AM deliveries × 100.",
    benchmark: "Target: 95%. Failure causes engineers to wait, directly reducing FTFR.",
  },
  pre_8am_success_rate: {
    meaning: "Percentage of ByBox smart locker deliveries completed before 08:00, so engineers collect parts before their first job.",
    howCalculated: "Locker deliveries confirmed by 07:59 ÷ total scheduled pre-8AM deliveries × 100.",
    benchmark: "Target: 95%. Failure causes engineers to wait, directly reducing FTFR.",
  },
  "pre 8am success rate": {
    meaning: "Percentage of ByBox smart locker deliveries completed before 08:00, so engineers collect parts before their first job.",
    howCalculated: "Locker deliveries confirmed by 07:59 ÷ total scheduled pre-8AM deliveries × 100.",
    benchmark: "Target: 95%. Failure causes engineers to wait, directly reducing FTFR.",
  },
  "pre 8am delivery success": {
    meaning: "Percentage of ByBox smart locker deliveries completed before 08:00, so engineers collect parts before their first job.",
    howCalculated: "Locker deliveries confirmed by 07:59 ÷ total scheduled pre-8AM deliveries × 100.",
    benchmark: "Target: 95%. Failure causes engineers to wait, directly reducing FTFR.",
  },
  "Pre-8AM Delivery": {
    meaning: "Percentage of ByBox smart locker deliveries completed before 08:00, so engineers collect parts before their first job.",
    howCalculated: "Locker deliveries confirmed by 07:59 ÷ total scheduled pre-8AM deliveries × 100.",
    benchmark: "Target: 95%. Failure causes engineers to wait, directly reducing FTFR.",
  },

  in_boot_availability: {
    meaning: "Percentage of jobs where the engineer already held the required part in their van, avoiding a mid-job parts trip.",
    howCalculated: "Jobs where part was on-van at dispatch ÷ total jobs × 100.",
    benchmark: "Target: 90%. Low values signal poor van stock replenishment or demand forecasting.",
  },
  "in boot availability": {
    meaning: "Percentage of jobs where the engineer already held the required part in their van, avoiding a mid-job parts trip.",
    howCalculated: "Jobs where part was on-van at dispatch ÷ total jobs × 100.",
    benchmark: "Target: 90%. Low values signal poor van stock replenishment or demand forecasting.",
  },
  "In-Boot Availability": {
    meaning: "Percentage of jobs where the engineer already held the required part in their van, avoiding a mid-job parts trip.",
    howCalculated: "Jobs where part was on-van at dispatch ÷ total jobs × 100.",
    benchmark: "Target: 90%. Low values signal poor van stock replenishment or demand forecasting.",
  },

  van_fill_accuracy: {
    meaning: "Percentage of van replenishment picks where the engineer's van was stocked with exactly the parts specified by the demand forecast.",
    howCalculated: "Correct van picks ÷ total van picks × 100.",
    benchmark: "Target: 92%. Poor accuracy causes in-boot mismatches and FTFR degradation.",
  },
  "van fill accuracy": {
    meaning: "Percentage of van replenishment picks where the engineer's van was stocked with exactly the parts specified by the demand forecast.",
    howCalculated: "Correct van picks ÷ total van picks × 100.",
    benchmark: "Target: 92%. Poor accuracy causes in-boot mismatches and FTFR degradation.",
  },

  forecast_accuracy_30d: {
    meaning: "Accuracy of the 30-day demand forecast for spare parts, comparing predicted vs actual consumption across all SKUs.",
    howCalculated: "1 − (|Actual − Forecast| ÷ Actual) × 100, averaged over all SKUs.",
    benchmark: "Target: 88%. Drives inventory positioning and pre-8AM locker fill decisions.",
  },
  "forecast accuracy 30d": {
    meaning: "Accuracy of the 30-day demand forecast for spare parts, comparing predicted vs actual consumption across all SKUs.",
    howCalculated: "1 − (|Actual − Forecast| ÷ Actual) × 100, averaged over all SKUs.",
    benchmark: "Target: 88%. Drives inventory positioning and pre-8AM locker fill decisions.",
  },

  locker_fill_rate: {
    meaning: "Percentage of ByBox smart lockers currently stocked with at least one part assigned to an upcoming job.",
    howCalculated: "Lockers with ≥1 stocked slot ÷ total active lockers × 100.",
    benchmark: "Target: 50% utilisation. Excess fill wastes capacity; under-fill misses engineers.",
  },
  "locker fill rate": {
    meaning: "Percentage of ByBox smart lockers currently stocked with at least one part assigned to an upcoming job.",
    howCalculated: "Lockers with ≥1 stocked slot ÷ total active lockers × 100.",
    benchmark: "Target: 50% utilisation. Excess fill wastes capacity; under-fill misses engineers.",
  },

  inter_engineer_transfers: {
    meaning: "Number of same-day part transfers between engineers in the field this week. High counts indicate van stock gaps or poor pre-job planning.",
    howCalculated: "Count of transfer events logged in the field dispatch system per week.",
    benchmark: "Target: <20/week. Transfers cost ~45 min per event and reduce FTFR.",
  },
  "inter engineer transfers": {
    meaning: "Number of same-day part transfers between engineers in the field this week. High counts indicate van stock gaps or poor pre-job planning.",
    howCalculated: "Count of transfer events logged in the field dispatch system per week.",
    benchmark: "Target: <20/week. Transfers cost ~45 min per event and reduce FTFR.",
  },

  // ── Cost ───────────────────────────────────────────────────────────────────
  expediting_cost_pct: {
    meaning: "Emergency freight and same-day courier spend as a percentage of total logistics cost. Spikes signal disruption or poor demand forecasting.",
    howCalculated: "Emergency freight spend ÷ total logistics spend × 100.",
    benchmark: "Target: <3%. Above 5% indicates a supply chain event requiring intervention.",
  },
  "expediting cost pct": {
    meaning: "Emergency freight and same-day courier spend as a percentage of total logistics cost. Spikes signal disruption or poor demand forecasting.",
    howCalculated: "Emergency freight spend ÷ total logistics spend × 100.",
    benchmark: "Target: <3%. Above 5% indicates a supply chain event requiring intervention.",
  },
  "Expediting Cost": {
    meaning: "Emergency freight and same-day courier spend as a percentage of total logistics cost. Spikes signal disruption or poor demand forecasting.",
    howCalculated: "Emergency freight spend ÷ total logistics spend × 100.",
    benchmark: "Target: <3%. Above 5% indicates a supply chain event requiring intervention.",
  },

  // ── Supplier ───────────────────────────────────────────────────────────────
  supplier_otif: {
    meaning: "On-Time-In-Full rate — the percentage of supplier purchase orders delivered on the agreed date and in the correct quantity.",
    howCalculated: "POs delivered on time AND in full ÷ total POs × 100.",
    benchmark: "Target: >92%. Below 80% for two consecutive weeks triggers a P4 exception.",
  },
  "supplier otif": {
    meaning: "On-Time-In-Full rate — the percentage of supplier purchase orders delivered on the agreed date and in the correct quantity.",
    howCalculated: "POs delivered on time AND in full ÷ total POs × 100.",
    benchmark: "Target: >92%. Below 80% for two consecutive weeks triggers a P4 exception.",
  },
  "Supplier OTIF": {
    meaning: "On-Time-In-Full rate — the percentage of supplier purchase orders delivered on the agreed date and in the correct quantity.",
    howCalculated: "POs delivered on time AND in full ÷ total POs × 100.",
    benchmark: "Target: >92%. Below 80% for two consecutive weeks triggers a P4 exception.",
  },

  otif_score: {
    meaning: "Individual supplier On-Time-In-Full score — the percentage of that supplier's POs delivered on time and in the correct quantity.",
    howCalculated: "Supplier POs delivered on time AND in full ÷ total POs from that supplier × 100.",
    benchmark: "Target: >92%. Below 80% triggers a supplier review. Below 70% triggers escalation.",
  },
  "OTIF Score": {
    meaning: "Individual supplier On-Time-In-Full score — the percentage of that supplier's POs delivered on time and in the correct quantity.",
    howCalculated: "Supplier POs delivered on time AND in full ÷ total POs from that supplier × 100.",
    benchmark: "Target: >92%. Below 80% triggers a supplier review. Below 70% triggers escalation.",
  },
  "OTIF": {
    meaning: "On-Time-In-Full rate — % of POs delivered on the agreed date in the correct quantity.",
    howCalculated: "POs on time AND in full ÷ total POs × 100.",
    benchmark: "Target: >92%.",
  },
  "Avg OTIF": {
    meaning: "Weighted average On-Time-In-Full rate across all active suppliers.",
    howCalculated: "Sum of (supplier OTIF × supplier PO volume) ÷ total PO volume.",
    benchmark: "Target: >92%. Fleet-wide average below 85% triggers Procurement Director review.",
  },

  composite_risk_score: {
    meaning: "Composite supplier risk score combining OTIF performance, financial health, geopolitical exposure, Sedex audit status, and Ariba compliance.",
    howCalculated: "Weighted average of 5 risk sub-scores (OTIF 35%, financial 25%, geopolitical 20%, Sedex 10%, Ariba 10%).",
    benchmark: "Score >80 = Low Risk (green). 60–80 = Medium (amber). <60 = High Risk (red) — triggers quarterly review.",
  },
  "Risk Score": {
    meaning: "Composite supplier risk score combining OTIF performance, financial health, geopolitical exposure, Sedex audit status, and Ariba compliance.",
    howCalculated: "Weighted average of 5 risk sub-scores (OTIF 35%, financial 25%, geopolitical 20%, Sedex 10%, Ariba 10%).",
    benchmark: "Score >80 = Low Risk (green). 60–80 = Medium (amber). <60 = High Risk (red).",
  },

  ariba_compliance_status: {
    meaning: "Status of the supplier's SAP Ariba contract compliance: whether their master agreement, pricing schedules, and certifications are current.",
    howCalculated: "Derived from SAP Ariba contract expiry dates and compliance certification timestamps.",
    benchmark: "Compliant = all documents current. Expiring 30d = action required. Expired = purchasing blocked until resolved.",
  },
  "Ariba Status": {
    meaning: "Status of the supplier's SAP Ariba contract compliance: whether their master agreement, pricing schedules, and certifications are current.",
    howCalculated: "Derived from SAP Ariba contract expiry dates and compliance certification timestamps.",
    benchmark: "Compliant = all documents current. Expiring 30d = action required. Expired = purchasing blocked until resolved.",
  },
  "Ariba Expiring 30d": {
    meaning: "Count of SAP Ariba contracts expiring within 30 days. Each must be renewed before expiry or purchasing will be blocked.",
    howCalculated: "Count of contracts where expiry_date ≤ today + 30 days and status ≠ 'expired'.",
    benchmark: "Zero is ideal. Each contract renewal takes 5–10 business days — action required immediately.",
  },
  "Ariba Expired": {
    meaning: "Count of SAP Ariba contracts that have already expired. Purchasing against expired contracts is non-compliant and must be resolved urgently.",
    howCalculated: "Count of contracts where expiry_date < today.",
    benchmark: "Must be zero. Any expired contracts block the purchasing team until resolved.",
  },

  sedex_risk_level: {
    meaning: "Supplier ethical risk level from Sedex (Supplier Ethical Data Exchange) audit — assesses labour standards, health & safety, and environmental practices.",
    howCalculated: "Based on Sedex SMETA audit results covering labour, health & safety, environment, and business ethics pillars.",
    benchmark: "Low = approved. Medium = monitoring required. High = corrective action plan mandatory.",
  },
  "Sedex Risk": {
    meaning: "Supplier ethical risk level from Sedex (Supplier Ethical Data Exchange) audit — assesses labour standards, health & safety, and environmental practices.",
    howCalculated: "Based on Sedex SMETA audit results covering labour, health & safety, environment, and business ethics pillars.",
    benchmark: "Low = approved. Medium = monitoring. High = corrective action required before next PO.",
  },

  "Emergency POs": {
    meaning: "Emergency purchase orders as a percentage of total POs raised. Emergency POs carry a freight premium and signal a supply chain gap.",
    howCalculated: "POs raised with po_type = 'emergency' ÷ total POs × 100.",
    benchmark: "Target: <5%. Above 10% indicates a structural supply issue or demand forecast failure.",
  },
  "SME Payment On-Time": {
    meaning: "Percentage of SME (small business) supplier invoices paid within the agreed payment term. ABC is a signatory to the Prompt Payment Code.",
    howCalculated: "SME invoices paid on or before due date ÷ total SME invoices × 100.",
    benchmark: "Prompt Payment Code commitment: ≥95% within 30 days. Non-compliance is publicly reported.",
  },

  // ── Exceptions ─────────────────────────────────────────────────────────────
  p1_response_time_min: {
    meaning: "Average time in minutes from a P1 (critical) exception being raised to the first operational response or acknowledgement.",
    howCalculated: "Sum of (first-response time − created time) for all P1 exceptions ÷ count of P1 exceptions.",
    benchmark: "Target: <5 minutes. SLA breach at 15 minutes triggers executive escalation.",
  },
  "p1 response time min": {
    meaning: "Average time in minutes from a P1 (critical) exception being raised to the first operational response or acknowledgement.",
    howCalculated: "Sum of (first-response time − created time) for all P1 exceptions ÷ count of P1 exceptions.",
    benchmark: "Target: <5 minutes. SLA breach at 15 minutes triggers executive escalation.",
  },
  "P1 Response Time": {
    meaning: "Average time in minutes from a P1 (critical) exception being raised to the first operational response or acknowledgement.",
    howCalculated: "Sum of (first-response time − created time) for all P1 exceptions ÷ count of P1 exceptions.",
    benchmark: "Target: <5 minutes. SLA breach at 15 minutes triggers executive escalation.",
  },

  // ── Warehouse / 3PL ───────────────────────────────────────────────────────
  throughput_vs_baseline_pct: {
    meaning: "Warehouse throughput expressed as a percentage of the site's baseline capacity (items picked and dispatched per hour under normal operations).",
    howCalculated: "Current items per hour ÷ baseline items per hour for the site × 100.",
    benchmark: "100% = normal operations. <75% = degraded (amber). <40% = P1 disruption event (red).",
  },
  "Throughput vs Baseline": {
    meaning: "Warehouse throughput expressed as a percentage of the site's baseline capacity (items picked and dispatched per hour under normal operations).",
    howCalculated: "Current items per hour ÷ baseline items per hour for the site × 100.",
    benchmark: "100% = normal. <75% = degraded. <40% = P1 threshold — triggers Playbook A.",
  },

  "Network Throughput": {
    meaning: "Pick-and-dispatch throughput across every 3PL site as one figure — the network's real fulfilment capacity today. A single degraded site matters far less than the same drop spread across all four, so the sites are weighted by the volume they are built to carry rather than averaged flat.",
    howCalculated: "Σ (site throughput % × site baseline items/hr) ÷ Σ (site baseline items/hr).",
    benchmark: "Target: ≥85% of baseline. 60–85% puts the network at risk; below 60% is a critical fulfilment failure.",
  },
  "Lowest Site": {
    meaning: "Throughput at the worst-performing 3PL site. The network figure can look healthy while one site is failing, and it is the failing site that generates the exceptions.",
    howCalculated: "Minimum throughput-vs-baseline % across all active sites.",
    benchmark: "Below 40% for 60 minutes trips the P1 3PL closure rule and activates Playbook A.",
  },

  courier_ot_rate: {
    meaning: "Percentage of courier dispatches from this warehouse departing on or before their scheduled collection time. Low rates delay engineers.",
    howCalculated: "Courier collections on-time ÷ total scheduled collections × 100.",
    benchmark: "Target: ≥95%. Below 90% indicates dock congestion or staffing issues.",
  },
  "Courier OT": {
    meaning: "Percentage of courier dispatches from this warehouse departing on or before their scheduled collection time. Low rates delay engineers.",
    howCalculated: "Courier collections on-time ÷ total scheduled collections × 100.",
    benchmark: "Target: ≥95%. Below 90% indicates dock congestion or staffing issues.",
  },

  items_per_hour: {
    meaning: "Current pick-and-dispatch rate at this warehouse, in items processed per hour. Directly determines same-day fulfillment capacity.",
    howCalculated: "Items picked and labelled in the current rolling hour, averaged over the last 3 hours.",
    benchmark: "Leicester CoE baseline: 3,500/hr. Below 50% of baseline triggers P1 alert.",
  },
  "Items/hr": {
    meaning: "Current pick-and-dispatch rate at this warehouse, in items processed per hour. Directly determines same-day fulfillment capacity.",
    howCalculated: "Items picked and labelled in the current rolling hour, averaged over the last 3 hours.",
    benchmark: "Leicester CoE baseline: 3,500/hr. Below 50% of baseline triggers P1 alert.",
  },

  // ── Labour Risk ────────────────────────────────────────────────────────────
  risk_score: {
    meaning: "Composite labour risk score for this warehouse site (0–100). Combines union activity level, news signals, management communication assessment, and staffing stability.",
    howCalculated: "Weighted composite: GMB activity 30%, Unite activity 20%, news signals 25%, management comms 15%, turnover 10%.",
    benchmark: "0–29 = Low Risk (green). 30–59 = Monitor (amber). 60–100 = High Risk (red) — Playbook A on standby.",
  },
  labour_risk_score: {
    meaning: "Composite labour risk score for this warehouse site (0–100), derived from absence trend, attrition, contingent-labour dependency, overtime strain, union sentiment and industrial-action stage — mirrors the same warehouse_status.labour_risk_score shown on the Live Field Ops.",
    howCalculated: "Weighted sum: absenteeism ×1.8, turnover above 10% ×1.1, agency staff % ×0.45, overtime % ×0.35, +10 for active GMB, +10 for active Unite, news signals (capped +15), +8–24 by industrial-action stage, +8 if comms disrupted. Redrawn live from current scenario state.",
    benchmark: "0–29 = Low Risk (green). 30–59 = Monitor (amber). 60–100 = High Risk (red).",
  },
  "Labour Risk Score": {
    meaning: "Composite labour risk score for this warehouse site (0–100), derived from absence trend, attrition, contingent-labour dependency, overtime strain, union sentiment and industrial-action stage.",
    howCalculated: "Weighted sum: absenteeism ×1.8, turnover above 10% ×1.1, agency staff % ×0.45, overtime % ×0.35, +10 for active GMB, +10 for active Unite, news signals (capped +15), +8–24 by industrial-action stage, +8 if comms disrupted.",
    benchmark: "0–29 = Low Risk. 30–59 = Monitor. 60+ = High Risk — triggers Playbook A standby.",
  },
  "Absenteeism Rate": {
    meaning: "Average network absenteeism rate across all tracked warehouse sites. A direct indicator of labour friction and operational instability.",
    howCalculated: "Percentage of scheduled labour hours lost to unplanned absences (sick leave, strikes, no-shows).",
    benchmark: "Under 5% = healthy. 5–8% = warning. >8% = critical risk of degraded throughput.",
  },
  "Turnover Rate": {
    meaning: "Rolling annualised staff turnover rate for this warehouse site — sustained high turnover raises training cost and erodes institutional knowledge on the pick face.",
    howCalculated: "Leavers over the trailing 12 months ÷ average headcount, as a percentage.",
    benchmark: "Under 16% = stable. 16–20% = warning. >20% = high risk of chronic understaffing.",
  },
  "Agency Staff %": {
    meaning: "Share of this site's active headcount supplied by agency/temp labour rather than permanent staff — the resilience buffer a site leans on when permanent absence or turnover rises, but a heavy reliance itself signals strain.",
    howCalculated: "Agency-supplied shift hours ÷ total shift hours for the current assessment period, as a percentage.",
    benchmark: "Under 15% = healthy mix. 15–25% = elevated dependency. >25% = high risk — site is structurally reliant on contingent labour.",
  },
  "Overtime %": {
    meaning: "Share of hours worked at this site that were overtime — a leading indicator of workforce strain before absenteeism or turnover moves.",
    howCalculated: "Overtime hours ÷ total hours worked for the current assessment period, as a percentage.",
    benchmark: "Under 15% = sustainable. 15–20% = watch. >25% = high risk of burnout-driven attrition.",
  },
  "Ballot Status": {
    meaning: "Industrial-action lifecycle stage for this site's recognised trade unions, from no activity through to strike action.",
    howCalculated: "Tracked from union notice communications: none → notice served → ballot open → action short of strike → strike action.",
    benchmark: "None = normal. Notice served / ballot open = escalate to HR Director. Action short of strike / strike action = activate the site's failover playbook.",
  },

  gmb_activity_level: {
    meaning: "GMB (General, Municipal, Boilermakers) union activity level at this site — an early indicator of potential industrial action or workforce unrest.",
    howCalculated: "Categorised by CLT news signal monitoring: 'none', 'monitoring', 'elevated', or 'active dispute'.",
    benchmark: "None = normal. Monitoring = watch closely. Elevated = management comms required. Active = escalate to HR Director.",
  },
  "GMB Activity": {
    meaning: "GMB (General, Municipal, Boilermakers) union activity level at this site — an early indicator of potential industrial action or workforce unrest.",
    howCalculated: "Categorised by CLT news signal monitoring: 'none', 'monitoring', 'elevated', or 'active dispute'.",
    benchmark: "None = normal. Monitoring = watch closely. Active = escalate to HR Director.",
  },

  unite_activity_level: {
    meaning: "Unite the Union activity level at this site — monitored alongside GMB as part of the CLT labour risk early warning system.",
    howCalculated: "Categorised by CLT news signal monitoring: 'none', 'monitoring', 'elevated', or 'active dispute'.",
    benchmark: "Same thresholds as GMB. Simultaneous elevation of both unions significantly raises risk score.",
  },
  "Unite Activity": {
    meaning: "Unite the Union activity level at this site — monitored alongside GMB as part of the CLT labour risk early warning system.",
    howCalculated: "Categorised by CLT news signal monitoring: 'none', 'monitoring', 'elevated', or 'active dispute'.",
    benchmark: "None = normal. Simultaneous GMB + Unite elevation triggers site visit from HR Director.",
  },

  news_signal_count: {
    meaning: "Number of news articles or social media signals in the past 7 days mentioning this warehouse site in the context of labour, pay, or working conditions.",
    howCalculated: "CLT news monitoring service signal count, filtered for relevance to site, labour, and industrial relations topics.",
    benchmark: "0–2 = background noise. 3–5 = monitor. 6+ = brief management team.",
  },
  "News Signals": {
    meaning: "Number of news/social media signals in the past 7 days mentioning this site in the context of labour, pay, or working conditions.",
    howCalculated: "CLT news monitoring service count, filtered for labour and industrial relations relevance.",
    benchmark: "0–2 = normal. 6+ = brief management team and review labour risk score.",
  },

  // ── Sustainability ─────────────────────────────────────────────────────────
  landfill_diversion_pct: {
    meaning: "Percentage of returned and end-of-life parts diverted from landfill via reconditioning, resale, or responsible recycling.",
    howCalculated: "Weight of parts not sent to landfill ÷ total returned part weight × 100.",
    benchmark: "Target: >95%. Part of ABC's People & Planet Plan zero-waste commitment.",
  },
  "landfill diversion pct": {
    meaning: "Percentage of returned and end-of-life parts diverted from landfill via reconditioning, resale, or responsible recycling.",
    howCalculated: "Weight of parts not sent to landfill ÷ total returned part weight × 100.",
    benchmark: "Target: >95%. Part of ABC's People & Planet Plan zero-waste commitment.",
  },
  "Landfill Diversion": {
    meaning: "Percentage of returned and end-of-life parts diverted from landfill via reconditioning, resale, or responsible recycling.",
    howCalculated: "Weight of parts not sent to landfill ÷ total returned part weight × 100.",
    benchmark: "Target: >95%. Part of ABC's People & Planet Plan zero-waste commitment.",
  },

  scope3_ytd_tco2e: {
    meaning: "Year-to-date Scope 3 CO₂-equivalent emissions (tCO₂e) from logistics, freight, and third-party supply chain activities.",
    howCalculated: "Sum of emission factors × activity data across all Scope 3 categories 4 (upstream transport) and 9 (downstream transport).",
    benchmark: "Target: <2,000 tCO₂e for the full financial year. Scope 3 is ABC's largest emission category.",
  },
  "scope3 ytd tco2e": {
    meaning: "Year-to-date Scope 3 CO₂-equivalent emissions from logistics and supply chain. Includes freight, last-mile delivery, and supplier transport.",
    howCalculated: "Sum of emission factors × activity data across Scope 3 categories 4 and 9.",
    benchmark: "Target: <2,000 tCO₂e FY. Part of ABC's net-zero 2045 pathway.",
  },
  "Scope 3 Emissions YTD": {
    meaning: "Year-to-date Scope 3 CO₂-equivalent emissions from logistics and supply chain. Includes freight, last-mile delivery, and supplier transport.",
    howCalculated: "Sum of emission factors × activity data across Scope 3 categories 4 and 9.",
    benchmark: "Target: <2,000 tCO₂e FY. Part of ABC's net-zero 2045 pathway.",
  },
  "Scope 3 YTD": {
    meaning: "Year-to-date Scope 3 CO₂-equivalent emissions from logistics and supply chain. Includes freight, last-mile delivery, and supplier transport.",
    howCalculated: "Sum of emission factors × activity data across Scope 3 categories 4 and 9.",
    benchmark: "Target: <2,000 tCO₂e FY.",
  },

  "Reconditioning Yield": {
    meaning: "Percentage of returned parts that pass quality inspection and are successfully reconditioned for reuse in the field.",
    howCalculated: "Parts passed reconditioning QA ÷ total parts received for reconditioning × 100.",
    benchmark: "Higher yield reduces new part procurement cost and carbon footprint.",
  },
  "Parts Reconditioned in Use": {
    meaning: "Count of reconditioned parts currently deployed in the field, directly replacing new part procurement and reducing carbon footprint.",
    howCalculated: "Live count of parts flagged as 'reconditioned' in active job assignments.",
    benchmark: "Each reconditioned part saves approximately 2.4 kg CO₂e vs. manufacturing new.",
  },
  "CO₂ Saved YTD": {
    meaning: "Tonnes of CO₂-equivalent emissions avoided year-to-date by using reconditioned parts instead of manufacturing new replacements.",
    howCalculated: "Count of reconditioned parts × average CO₂e saving per part (2.4 kg) ÷ 1,000.",
    benchmark: "Contributes directly to ABC's Scope 3 reduction target.",
  },
  "WEEE Compliance": {
    meaning: "Percentage of Waste Electrical & Electronic Equipment disposed of in full compliance with the WEEE Directive, ensuring legal and environmental obligations are met.",
    howCalculated: "WEEE-compliant disposals ÷ total WEEE disposals × 100.",
    benchmark: "Legal minimum: 100%. Non-compliance carries regulatory fines.",
  },

  // ── IoT / Smart Tech ───────────────────────────────────────────────────────
  "Active Fault Signals": {
    meaning: "Number of Hive smart home sensors currently reporting a high-probability boiler fault predicted to occur within 24 hours.",
    howCalculated: "Count of BoilerIQ signals with fault_probability > 0.7 and status = 'high_risk' in the rolling 24-hour window.",
    benchmark: "Baseline ~3,500/day. Surge during cold snaps (Beast from East: +45%).",
  },
  "Pre-positioning Triggered": {
    meaning: "Predicted faults where the part has been committed to the job ahead of the customer's call — the signal is confident enough to act on AND the part that clears it is actually within reach.",
    howCalculated: "Signals with fault_probability ≥ 0.85 whose required part is either spare on a van in that region or available to pick at the NDC. Cover is read off live van stock and NDC availability, so this can never claim a part the network does not hold.",
    benchmark: "High pre-positioning correlates with improved FTFR and reduced emergency callouts.",
  },
  "Parts Cover": {
    meaning: "Of the fault signals confident enough to act on, the share whose part we can actually get to the job — the ceiling on how many predicted faults can be fixed first time.",
    howCalculated: "Actionable signals (fault_probability ≥ 0.85) with parts cover ÷ all actionable signals × 100. A part counts as covered when a van in the region carries a spare above its own minimum, or the NDC has it available to transfer.",
    benchmark: "Below 100% means predicted jobs we already know we cannot fix first time. Each uncovered signal is a wasted visit and a second appointment.",
  },
  "Pre-positioning Blocked": {
    meaning: "High-probability faults we can see coming but cannot cover — the part is on no van in the region and none is free at the NDC.",
    howCalculated: "Count of signals with fault_probability ≥ 0.85 and parts_cover = 'none'. These are the rows the worklist puts first.",
    benchmark: "Zero is the target. Anything above zero is a known future failed visit and should drive an emergency transfer or supplier expedite.",
  },
  "Connected Devices": {
    meaning: "Devices the control tower is currently taking decisions from — the Hive boiler estate reporting faults, DCC-registered smart meters, and connected vans.",
    howCalculated: "Live boiler fault signals + smart meters registered with the DCC + vans with a telematics unit.",
    benchmark: "The prediction pipeline is only worth what its inputs are worth; a shrinking estate means more blind spots.",
  },
  "Van Telemetry Health": {
    meaning: "Share of connected vans that have reported a telematics ping within the last hour. A van that has gone quiet is still working — we just cannot see it.",
    howCalculated: "Vans with minutes_since_ping ≤ 60 ÷ total connected vans × 100. Units ping every 30–60 seconds while the ignition is on.",
    benchmark: "≥95% is a healthy estate. Sustained gaps usually mean a flat unit or a known comms blackspot rather than a stopped van.",
  },
  "Proactive Outreach Queued": {
    meaning: "Number of customer outreach messages queued for engineers to arrange preventive maintenance visits, based on IoT fault predictions.",
    howCalculated: "Count of signals where proactive_outreach_queued = true and customer contact not yet made.",
    benchmark: "Proactive outreach reduces emergency P1 boiler failures by approximately 30%.",
  },
  "SMET2 Installed YTD": {
    meaning: "Total SMETS2 smart meters installed year-to-date under the MHHS (Market-wide Half Hourly Settlement) regulatory programme.",
    howCalculated: "Cumulative count of meters with installation_status = 'installed' from 01 April to today.",
    benchmark: "Target set by Ofgem. Contributes to the UK's net-zero and energy efficiency goals.",
  },

  // ── Executive Dashboard Tier-1 additions ────────────────────────────────────
  "Inventory Accuracy": {
    meaning: "How closely stock records match physically counted stock across all warehouses — the foundation every replenishment and promise-date decision rests on.",
    howCalculated: "SKU-locations where system quantity matches the last cycle count ÷ SKU-locations counted × 100.",
    benchmark: "World-class operations with cycle counting sustain ≥98%; below 95% forces safety-stock inflation.",
  },
  "Cost per Install": {
    meaning: "Average fully-loaded logistics cost to complete one equipment installation — parts movement, last-mile delivery, engineer travel and returns.",
    howCalculated: "Total fulfilment cost ÷ completed installations, rolling 30 days.",
    benchmark: "Target ≤£210. Route optimization and first-time-fix improvements are the biggest levers.",
  },
  "SLA Breach Rate": {
    meaning: "Percentage of jobs that missed their contractual service-level window (e.g. next-day boiler repair, 4-hour P1 response).",
    howCalculated: "Jobs completed outside their SLA window ÷ total jobs × 100, rolling 7 days.",
    benchmark: "Keep below 3%. Each breach carries compensation exposure and drives CSAT down.",
  },
  // ── Jobs at SLA risk · the cross-module leading indicator ───────────────────
  "Jobs at SLA Risk": {
    meaning: "Appointments still outstanding today that are currently on course to miss their promised time slot. Two things cause it, and they sit in two different teams: the van will not ARRIVE in time (Transport Control), or it will arrive WITHOUT THE PART (Field Operations). This is the count of jobs affected by either — while there is still time to do something about it. Jobs already completed are excluded from both the count and the denominator: a finished appointment cannot go on to miss its window.",
    howCalculated: "Every remaining stop on every live round is checked twice: once against its SLA deadline using the round's current delay, and once against the van's stock. A job appearing in both counts once, not twice — so this is the number of appointments at risk, not the number of problems. It is therefore SMALLER than the two module counts added together: Parts + Arrival − jobs hit by both = this figure. The Field Operations and Transport Control panels each show their own full exposure plus the shared count, so the difference is always visible on the page. The denominator is uncompleted appointments on the same filter, so numerator and denominator describe the same population.",
    benchmark: "Target: ≤8% of the jobs still outstanding. Above 12.8% is red. It sits deliberately above the 3% SLA Breach Rate target because these jobs have not breached yet — every one carries a costed recovery option in Live Visibility or Transport Control, and most get saved. Read it against work REMAINING, not the day's schedule: completed appointments are out of both the count and the denominator, so the ratio tightens as the day burns down. Ten at-risk jobs with 50 left is a worse position than ten with 500, and the figure says so.",
  },
  "Jobs at Risk · Parts": {
    meaning: "Today's remaining appointments on rounds where the engineer's van has run out of a part it is supposed to carry. The engineer will reach the customer but may not be able to finish the job — which costs a second visit and the first-time-fix rate along with it.",
    howCalculated: "Remaining stops on every round with at least one van-stock line at zero. Vans that are merely below their minimum are excluded: the part is still in the boot and the job still gets done, so that is a replenishment signal rather than a service risk. This is Field Operations' TOTAL exposure, so it overlaps Transport Control's arrival figure — do not add the two. Both cover the same day's appointments and share the jobs on the \"also late in transit\" line below; the headline Jobs at SLA Risk card is the deduplicated union.",
    benchmark: "Fixable today: each affected round carries transfer, reallocate, collect-en-route and replenish options. Because there is no per-job parts list, this is an upper bound for the rounds involved — some of those jobs will not need the missing part.",
  },
  "Jobs at Risk · Arrival": {
    meaning: "Today's remaining appointments where the round is running late enough that the projected arrival falls outside the customer's promised window. The engineer has the parts — they simply will not get there in time.",
    howCalculated: "For every round 10 minutes or more behind, each remaining stop's planned arrival is pushed out by the current delay and compared with its SLA deadline. Stops now past the deadline are counted. This is Transport Control's TOTAL exposure, so it overlaps Field Operations' parts figure — do not add the two. Both cover the same day's appointments and share the jobs on the \"also short of parts\" line below; the headline Jobs at SLA Risk card is the deduplicated union.",
    benchmark: "Recoverable by re-sequencing, reassigning the tail of the round, or warning the customer early. The grace on the window depends on the commitment: 15 min on a P1 emergency callout, 30 on a P2 repair, 60 on a routine service.",
  },
  // The reconciliation figure. It exists so the three jobs-at-risk numbers on the
  // Executive Dashboard visibly add up, rather than looking like three sources
  // disagreeing about the same day.
  "Jobs at Risk · Both Causes": {
    meaning: "Today's appointments that are failing on BOTH counts at once — the round is running late AND the van is missing a part. These jobs appear in the Field Operations figure and in the Transport Control figure, which is why those two cannot be added together. They also need two fixes, not one: recovering the round's time does not put the part in the boot.",
    howCalculated: "The intersection of the two cause sets over job codes. The arithmetic that closes the page: Parts + Arrival − Both = the headline Jobs at SLA Risk. The headline counts each affected appointment once.",
    benchmark: "Expect a small number — but it is rarely zero, because a round losing time is disproportionately likely to be the round that is also short of stock. Work these first: they are the jobs where a single-team fix will not save the appointment.",
  },
  "Rounds Short of Stock": {
    meaning: "Engineers whose van is out of a part it should be carrying. One round can put several of today's appointments at risk, which is why the job count is always the larger number.",
    howCalculated: "Count of open van-stock alerts with at least one line at zero quantity.",
    benchmark: "Every one of these has an open action queue entry in the Live Field Ops with four costed ways to close it.",
  },
  "Rounds Running Late": {
    meaning: "Live rounds currently projected to miss at least one booked appointment. A round can be behind schedule without being at risk — it only appears here once the delay actually eats into a customer's window.",
    howCalculated: "Count of open arrival-risk rows: rounds 10 minutes or more behind with at least one remaining stop projected past its SLA deadline.",
    benchmark: "Traffic severity drives this: a normal day runs ~10% of live rounds behind, a severe weather day ~40%.",
  },

  "Open Exceptions": {
    meaning: "Exceptions currently unresolved across the network, split by priority. P1 is a live incident with customer impact; P4 is a signal worth watching.",
    howCalculated: "Count of exceptions with status = open, grouped by their assigned priority.",
    benchmark: "Any open P1 puts the whole network into a critical state. P2s left unowned are what become tomorrow's P1s.",
  },
  "Transit Exceptions": {
    meaning: "Shipments currently flagged as delayed in transit — inbound stock that will not arrive when the plan assumed it would.",
    howCalculated: "Count of shipments with status = delayed.",
    benchmark: "Target ≤10 concurrent. Sustained volume above that usually means a carrier or traffic problem, not bad luck.",
  },

  // ── Demand & Inventory panel ────────────────────────────────────────────────
  "At-Risk SKUs": {
    meaning: "SKUs whose availability is degraded — below safety stock, inside their reorder window, or already stocked out.",
    howCalculated: "Count of SKUs with an Amber or Red stock status across all warehouses.",
    benchmark: "A healthy network runs at zero-to-two at-risk SKUs; a spike signals a demand shock or inbound failure.",
  },
  "Avg Days of Supply": {
    meaning: "How many days current stock will last at the demand-adjusted daily consumption rate, averaged across tracked SKUs.",
    howCalculated: "Σ (on-hand ÷ adjusted daily consumption) ÷ SKU count. Weather and IoT demand uplifts raise consumption and shrink cover.",
    benchmark: "≥7 days is comfortable; below lead time means a stockout is already in flight.",
  },
  "Fill Rate": {
    meaning: "Share of SKUs holding at least their safety-stock level — a forward-looking availability measure.",
    howCalculated: "SKUs with available quantity ≥ safety stock ÷ total SKUs × 100.",
    benchmark: "≥95% keeps first-time-fix protected; each point below leaks failed jobs.",
  },
  "Stockouts": {
    meaning: "SKUs with zero available stock anywhere in the network — engineers cannot be replenished for these parts.",
    howCalculated: "Count of SKUs where available quantity = 0 across all warehouses.",
    benchmark: "Zero is the only acceptable steady state; any stockout on a critical SKU triggers an automatic emergency PO.",
  },
  "Weather Demand Uplift": {
    meaning: "Multiplier applied to baseline parts demand from Met Office temperature forecasts — cold snaps drive boiler failures up sharply.",
    howCalculated: "Regression of historical demand vs temperature; ×1.4+ indicates severe-weather surge conditions.",
    benchmark: "Sustained cold below −5°C ('Beast from the East' pattern) can lift demand ×1.4 within 48 hours.",
  },
  "Heat Pump BOMs Active": {
    meaning: "Live heat-pump installation quotes (bills of materials) in the CPQ pipeline — the leading indicator of heat-pump parts demand.",
    howCalculated: "Count of open CPQ configurations containing a heat pump unit.",
    benchmark: "A sudden multiple of the baseline (e.g. after a grant announcement) warrants pre-emptive OEM orders — lead times run 14-20 weeks.",
  },
  "EV Charger BOMs Active": {
    meaning: "Live EV-charger installation quotes in the CPQ pipeline, feeding the EV charger parts forecast.",
    howCalculated: "Count of open CPQ configurations containing an EV charge point.",
  },

  // ── Transport panel additions ───────────────────────────────────────────────
  "On-Time Delivery": {
    meaning: "Percentage of scheduled deliveries (locker pre-8AM, trunk moves, direct-to-van) arriving inside their planned window.",
    howCalculated: "Deliveries on time ÷ total scheduled × 100, trailing 24h. Traffic severity and VOR vans degrade it.",
    benchmark: "≥95% target; sustained dips usually trace to carrier capacity or weather.",
  },
  "Fleet Utilisation": {
    meaning: "Share of the whole fleet actually out working. Vans sitting idle and vans off the road both drag it down, which is the point — a van that cannot be deployed costs the same as a van nobody deployed.",
    howCalculated: "Vans on active routes ÷ total fleet size × 100. VOR vans stay in the denominator, so every vehicle withdrawn from service shows up here as lost capacity.",
    benchmark: "90% is the sweet spot; above 96% leaves no surge capacity for P1 response.",
  },
  "Active Vehicles": {
    meaning: "Vans in service right now — roadworthy and either available, driving to a job, or on site. The live measure of field logistics capacity.",
    howCalculated: "Count of vans that are not VOR and whose status is available, en route or on site. Off-duty vans and vans on break are excluded.",
    benchmark: "Read alongside VOR: a fleet of 200 with 12 VOR can never show more than 188 active, however good the scheduling is.",
  },
  "Fuel Efficiency": {
    meaning: "Average fleet fuel economy across diesel vans — a cost and Scope 1 emissions lever.",
    howCalculated: "Telematics-reported miles ÷ fuel drawn, fleet-weighted, trailing 7 days.",
    benchmark: "≥38 mpg for the diesel van profile; harsh driving and congestion routing erode it.",
  },
  "Freight Spend": {
    meaning: "Month-to-date third-party freight cost — trunk moves, courier runs and emergency shipments.",
    howCalculated: "Σ carrier invoices + committed bookings this calendar month.",
    benchmark: "Budget £45k/month; expediting during disruptions is the usual cause of overshoot.",
  },

  // ── Field Operations panel ──────────────────────────────────────────────────
  "Active Engineers": {
    meaning: "Field engineers on shift right now across all regions and business units.",
    howCalculated: "Engineers with an active session and an assigned route today.",
  },
  "Engineers On-Site": {
    meaning: "Engineers currently at a customer property performing a job.",
    howCalculated: "Engineers whose latest status event is 'on site'.",
  },
  "Van Stock Low": {
    meaning: "Engineers whose van inventory has dropped below minimum for at least one job-critical part.",
    howCalculated: "Count of engineers with any van-stock line below its per-van minimum.",
    benchmark: "Watch the trend: a network-wide spike predicts first-time-fix decline within 24-48 hours.",
  },
  "Locker Gaps": {
    meaning: "ByBox locker sites currently flagged for attention. Two different failures land here: the overnight pre-8AM delivery was not confirmed, so engineers assigned there start the day without parts; or the locker is over 85% full and has no free compartment for tonight's wave.",
    howCalculated: "Count of locker sites with status = alert — pre-8AM delivery unconfirmed OR fill above 85%. The pre-8AM half is the urgent one and carries its own resolutions in the Live Field Ops's Lockers tab.",
    benchmark: "Target zero. Each missed site affects 3–6 engineers' first jobs; a full locker blocks tonight's replenishment rather than this morning's collection.",
  },
  "Available for Dispatch": {
    meaning: "Engineers who are on shift, not currently on a job, and able to take a P1 assignment now.",
    howCalculated: "Active engineers minus those on-site, driving to a fixed appointment, or on break.",
  },
  "Pending Transfers": {
    meaning: "Open inter-engineer van-stock transfers — parts moving van-to-van to cover local shortages.",
    howCalculated: "Transfer requests raised but not yet confirmed complete.",
  },
  "Lockers Pre-loaded": {
    meaning: "Locker compartments successfully loaded with parts in last night's pre-8AM wave.",
    howCalculated: "Compartment-level scan confirmations from the overnight delivery run.",
  },

  // ── Supplier Risk panel ─────────────────────────────────────────────────────
  "Risk Flags": {
    meaning: "Suppliers carrying an active financial-health or geopolitical risk flag from continuous Ariba monitoring.",
    howCalculated: "Count of suppliers with financial_health_flag or geopolitical_risk_flag set.",
    benchmark: "Any flagged Tier-1 supplier should have a contingency source identified within 5 working days.",
  },

  // ── IoT panel additions ─────────────────────────────────────────────────────
  "Smart Meter BOMs": {
    meaning: "Live smart-meter installation quotes in the CPQ pipeline, feeding SMETS2 kit demand under the MHHS programme.",
    howCalculated: "Count of open CPQ configurations containing a SMETS2 meter kit.",
  },
  "Install Rate": {
    meaning: "Smart meters being installed per week against the MHHS regulatory trajectory.",
    howCalculated: "Rolling 7-day count of completed SMETS2 installations.",
    benchmark: "Must average ≥1,000/week to hit the Q3 Ofgem milestone.",
  },
  "Top Boiler Fault Type": {
    meaning: "The most frequent fault signature in the last 24h of Hive boiler telemetry — tells you which part to pre-position.",
    howCalculated: "Mode of fault classifications across high-probability IoT signals, trailing 24h.",
  },

  // ── Sustainability panel additions ──────────────────────────────────────────
  "Reconditioned Value": {
    meaning: "Procurement spend avoided year-to-date by redeploying reconditioned parts instead of buying new.",
    howCalculated: "Σ (new-part list price − reconditioning cost) for every reconditioned part reused.",
  },
  "BSI-certified Batches": {
    meaning: "Reconditioned-part batches certified against the BSI standard for remanufactured components this year.",
    howCalculated: "Count of batches passing BSI audit; certification is required before reconditioned parts enter van stock.",
  },
  "People & Planet Plan": {
    meaning: "Overall status against ABC's People & Planet commitments in scope for supply chain: circular parts, fleet electrification and Scope 3 reduction.",
    howCalculated: "On track when all in-scope programme milestones are green for the current quarter.",
  },

  // ── Weekly report strip ─────────────────────────────────────────────────────
  "Exceptions Raised": {
    meaning: "Total exceptions created this week across all priorities — the raw workload signal for the control tower.",
    howCalculated: "Count of exception records with created_at inside the current reporting week.",
  },
  "POs Raised": {
    meaning: "Purchase orders created this week, including automatic emergency POs raised for critical stockouts.",
    howCalculated: "Count of POs with ordered_at inside the current reporting week.",
  },
  "AI Plans Activated": {
    meaning: "AI response plans a user has activated on exceptions this week — each triggers real compensatory actions across the network.",
    howCalculated: "Count of exceptions with plan_activated set during the reporting week.",
  },
  "En Route": {
    meaning: "Engineers currently driving to a job site. Positions update every 30 seconds via GPS.",
    howCalculated: "Engineers whose latest status event is 'en_route'.",
  },
  "SKUs at Risk": {
    meaning: "Count of SKUs currently at risk of stockout or low inventory.",
    howCalculated: "SKUs flagged with Amber or Red RAG status.",
  },
  "Active Stockouts": {
    meaning: "Number of SKUs with zero available stock.",
    howCalculated: "Count of SKUs where available quantity is 0.",
  },
  "Avg Days of Cover": {
    meaning: "Average inventory coverage across the portfolio.",
    howCalculated: "Average of Days of Supply for all tracked SKUs.",
  },
  "Open PO Value": {
    meaning: "Total GBP value of all active purchase orders currently in the pipeline.",
    howCalculated: "Sum of total_value_gbp for all open POs.",
  },
  // "Fill Rate", "Emergency POs", "Active Fault Signals", "Pre-positioning
  // Triggered", "Proactive Outreach Queued", "SMET2 Installed YTD", "Landfill
  // Diversion", "Reconditioning Yield", "Parts Reconditioned in Use",
  // "CO₂ Saved YTD", "Scope 3 Emissions YTD" and "WEEE Compliance" are defined
  // (with benchmarks) in their module sections above.

  // ── Demand & Inventory Control Tower ───────────────────────────────────────
  // The closed loop: Sense → Position → Execute → Orchestrate → Learn.

  "Working Capital": {
    meaning: "The cash tied up in stock sitting on shelves right now. Inventory is the single largest controllable item on most supply-chain balance sheets — every pound here is a pound not available for anything else.",
    howCalculated: "Σ (quantity on hand × unit cost) across every SKU in scope. Days of cover = stock value ÷ (annual cost of goods ÷ 365).",
    benchmark: "Distribution businesses typically target 45–70 days of working capital in stock. Lower is better — but cutting too far trades cash for stockouts.",
  },
  "Value at Risk": {
    meaning: "The replenishment spend needed right now to rescue SKUs that have already gone critical. It is the price of inaction — the money you must commit today because a buffer was breached.",
    howCalculated: "Σ (target order quantity × unit cost) for every SKU with a Red status. Target order qty comes from the order-up-to policy.",
    benchmark: "Should trend toward zero on a well-run network. A persistently high figure means buffers are mis-sized, not that buying is too slow.",
  },
  "Excess Capital": {
    meaning: "Cash frozen in stock above what the policy says you need. Excess is the quiet killer — it does not raise an alarm like a stockout, but it silently consumes cash and ages toward obsolescence.",
    howCalculated: "Σ (units above the order-up-to target × unit cost), counted only where a SKU is healthy AND holds more than 125% of its target.",
    benchmark: "Best-in-class holds excess below 5% of total stock value. Above 10% signals over-forecasting or stale buffer settings.",
  },
  "GMROI": {
    meaning: "Gross Margin Return on Inventory Investment — how many pounds of gross profit each pound invested in stock generates in a year. The single best measure of whether inventory is earning its keep.",
    howCalculated: "Annual gross margin ÷ average inventory value at cost. Here: (annual COGS × gross margin %) ÷ stock value.",
    benchmark: "Below 1.0× the inventory loses money. Distributors target 2.0–3.5×. Slow-moving spares naturally sit lower than fast-moving consumables.",
  },
  "Inventory Turns": {
    meaning: "How many times a year the whole stockholding sells through and is replaced. Higher turns mean the same service level is achieved with less cash.",
    howCalculated: "Annual cost of goods sold ÷ average inventory value.",
    benchmark: "4–8 turns is typical for service-parts distribution. Doubling turns roughly halves the working capital needed for the same revenue.",
  },
  "Open Actions": {
    meaning: "Everything in the module that needs a human decision — critical stockouts, low-stock replenishments, excess to dispose of and supplier risks — in one prioritised queue.",
    howCalculated: "Generated from live positions: Red SKUs, Amber SKUs, excess flags and suppliers below OTIF target. Each carries an owner, an SLA and the capital it puts at risk.",
    benchmark: "A healthy planner clears critical items within their 8-hour SLA. A growing backlog is an early warning that policy, not effort, is the problem.",
  },
  "Planner Worklist": {
    meaning: "The control-tower work queue. Instead of hunting through tables, the planner gets one list ranked by pounds at risk — so the highest-value decision is always at the top.",
    howCalculated: "Every open issue is scored by value at risk (order qty × unit cost), assigned a priority (critical/high/medium/low), an owner role and an SLA in hours, then sorted.",
    benchmark: "Ranking by £ rather than by cover-days is what separates a control tower from a report — it stops planners spending equal effort on a £50 valve and a £3,200 heat-pump kit.",
  },
  "Value at Risk (item)": {
    meaning: "The cash exposure of this single action — what it costs to fix, and by implication what is at stake if it is not fixed.",
    howCalculated: "Target order quantity × unit cost. Low-stock items are weighted at 50% since they have not yet breached.",
  },
  "SLA": {
    meaning: "The time within which this action should be resolved before it escalates. Critical stockouts get hours; excess disposition gets days.",
    howCalculated: "Assigned by issue type: stockout 8h, low stock 24h, excess 72h, supplier risk 168h (one week).",
    benchmark: "SLA adherence, not raw queue length, is the metric that predicts service-level performance.",
  },

  // ── SENSE ──
  "Demand Model": {
    meaning: "How future demand is predicted. This model is deliberately causal, not statistical guesswork: a base rate shaped by seasonality, then adjusted by live weather and IoT fault signals. Every unit of forecast can be traced to a driver.",
    howCalculated: "Forecast = base demand × category seasonality × (1 + weather effect + IoT effect). Each signal is scoped to the product categories it genuinely moves.",
    benchmark: "Causal (driver-based) forecasting typically beats naive time-series by 10–25% on volatile spares — and, crucially, it can explain itself to the planner.",
  },
  "Live Driver Strength": {
    meaning: "How hard each demand signal is pushing right now, relative to its normal level. Positive means demand is being driven up; negative means conditions are suppressing it.",
    howCalculated: "Each signal's deviation from its reference level × its elasticity. Elasticity is how sensitive demand is to that signal — e.g. boiler parts respond strongly to cold, not at all to EV grants.",
    benchmark: "A driver that never moves is either mis-scoped or not a real driver — this view exists to keep the model honest.",
  },
  "Heating Degree Days": {
    meaning: "The classic UK measure of how cold it is, and the strongest single predictor of boiler breakdown demand. Cold weather drives boiler failures, which drives spare-part consumption.",
    howCalculated: "Σ over the next 7 days of (15.5°C − daily temperature), counted only when below 15.5°C. Compared against a seasonal reference to produce the demand effect.",
    benchmark: "A cold snap can lift boiler-part demand 30–50% within 72 hours — far faster than a supplier lead time, which is why pre-positioning matters.",
  },
  "Frozen Condensate Risk": {
    meaning: "When temperatures fall below about −2°C, condensate pipes on modern condensing boilers freeze and lock the boiler out. It is the single biggest cause of UK cold-snap callouts.",
    howCalculated: "Flagged when the 7-day forecast minimum drops to −2°C or below. Applies a fixed demand uplift to boiler parts.",
    benchmark: "During the 2018 'Beast from the East' UK breakdown volumes roughly tripled, overwhelmingly from condensate lockouts.",
  },
  "Hive IoT Faults": {
    meaning: "Connected-boiler telemetry predicting failures before the customer notices. This converts reactive demand into demand you can see coming, days ahead.",
    howCalculated: "High-probability fault signals in the last 24h, compared against the normal running rate, scaled by elasticity onto the parts those faults consume.",
    benchmark: "Predictive fault signals typically give 3–10 days of warning — comfortably inside most parts lead times, which is what makes pre-positioning viable.",
  },
  "Signal Multiplier": {
    meaning: "The combined effect of all live signals on this SKU's demand rate. ×1.00 means normal; ×1.30 means demand is running 30% above baseline right now.",
    howCalculated: "1 + the sum of every driver effect that applies to this SKU's category, clamped to a sensible band (0.6–1.9).",
    benchmark: "This is what makes demand sensing real: a uniform uplift applied to every SKU is cosmetic — a per-category multiplier changes what you actually order.",
  },
  "Seasonality Factor": {
    meaning: "The predictable annual rhythm of demand for this product category, independent of weather. Boiler parts peak in winter; heat-pump and EV installs peak in the spring/summer build window.",
    howCalculated: "Category-specific monthly index averaged over the forecast horizon, where 1.00 is the annual average.",
    benchmark: "UK boiler part demand routinely swings ±35% between July and January — ignoring seasonality guarantees both summer excess and winter stockouts.",
  },
  "Demand Chart": {
    meaning: "One continuous view of demand: what actually happened over the last 30 days, and what the model expects over the next 30. Seeing both on one axis is how a planner judges whether the forecast is credible.",
    howCalculated: "Actuals are real consumption history. The forecast applies base × seasonality × weather × IoT. Both halves use the same model, so any step change at 'today' would signal a modelling error, not real demand.",
    benchmark: "The confidence band widens with horizon because uncertainty compounds. If actuals repeatedly fall outside the band, the model needs retuning — that is what the Learn plane watches.",
  },

  // ── POSITION ──
  "Statistical Safety Stock": {
    meaning: "The buffer held to absorb variability, sized by mathematics rather than judgement. It answers: how much stock do I need so that I only run out as often as my service target permits?",
    howCalculated: "SS = z × √( protection period × σ²demand + demand² × σ²lead-time ), where z comes from the service-level target. It accounts for BOTH demand volatility and supplier unreliability.",
    benchmark: "A hand-set constant is the most common inventory failure in industry: it is too high for stable items (wasting cash) and too low for volatile long-lead items (causing the stockouts that hurt most).",
  },
  "Service Level Target": {
    meaning: "The probability of not stocking out during a replenishment cycle. It is a deliberate business choice — higher service costs more cash, so it should differ by how important the item is.",
    howCalculated: "Set by ABC/XYZ segment: high-value A items get ~98.5%, low-value C items ~95%, with volatile Z items adjusted down because buffering them is disproportionately expensive.",
    benchmark: "Moving from 95% to 99% service roughly doubles safety stock. Differentiating by segment — rather than one blanket target — is where the cash saving comes from.",
  },
  "Multi-Echelon Optimisation": {
    meaning: "Deciding where in the network to hold buffer stock, not just how much. Holding one pooled buffer centrally covers variability far more efficiently than every site buffering alone.",
    howCalculated: "Compares the buffer actually held (hubs cover only the short transfer lead; the NDC pools against the long supplier lead) against a counterfactual where every site independently buffers the full supplier lead.",
    benchmark: "Risk pooling typically frees 20–35% of safety-stock capital for the same service level — one of the largest single cash levers in distribution.",
  },
  "Single-Echelon Sizing": {
    meaning: "The counterfactual: every location sizes its own buffer independently, against the full supplier lead time, as though no stock were held upstream on its behalf. It is what most planning systems do by default.",
    howCalculated: "For each site: z × √( (supplier lead + review) × σ²demand + demand² × σ²lead ), summed across all sites and priced at unit cost.",
    benchmark: "Because it ignores the network, the same protection gets bought twice — once at the hub and again at the NDC. That duplication is pure working capital with no service benefit.",
  },
  "Echelon Stock": {
    meaning: "The policy actually in force: a location's buffer accounts for the inventory held downstream that it supplies. Hubs cover only the 1–2 day trunker lead; the NDC pools the aggregate variability against the long supplier lead.",
    howCalculated: "Each site is sized against its OWN replenishment lead, not the supplier's — so a hub behind a 1-day transfer carries a fraction of what it would need if it bought direct.",
    benchmark: "Pooling n locations cuts the required buffer by roughly √n. This is the single largest cash lever available in a two-echelon network.",
  },
  "Newly Critical SKUs": {
    meaning: "How many SKUs the simulated shock pushes from healthy into critical — the breadth of the damage, before you look at its cost.",
    howCalculated: "Re-projects each position under the shock and counts those whose cover falls below the replenishment lead time, comparing against how many were already critical.",
    benchmark: "A shock that tips a handful of SKUs is absorbable; one that tips dozens means the buffers were sized for calm weather only.",
  },
  "Units Short": {
    meaning: "The total shortfall across the network under the simulated conditions — the physical gap between what demand would consume and what is on hand.",
    howCalculated: "For every SKU that goes critical: (shocked daily demand × lead time) − available stock, summed across the network.",
    benchmark: "Convert this to jobs, not just units: a short valve is a customer without heating, which is why the recovery cost is almost always worth paying.",
  },
  "Capital Released": {
    meaning: "The cash freed by pooling buffer stock centrally instead of duplicating it at every site — real money returned to the business for identical customer service.",
    howCalculated: "Decentralised safety-stock value − pooled safety-stock value, priced at unit cost.",
    benchmark: "Pooling benefit grows with the square root of the number of locations — the more sites you have, the more duplication costs you.",
  },
  "Excess & Obsolescence": {
    meaning: "Stock above what policy requires, with a decision attached. Excess does not fix itself: without an explicit disposition it simply ages until it is written off at zero.",
    howCalculated: "Units above the order-up-to target, valued at cost. Recommended disposition depends on demand elsewhere: rebalance if another site is short, return to vendor for volatile items, otherwise mark down.",
    benchmark: "Recovery rates fall fast with age: rebalance ~95%, return to vendor ~70%, markdown ~55%, write-off 0%. Acting early is worth multiples of acting late.",
  },
  "Holding Cost": {
    meaning: "The annual cost of simply owning stock — capital tied up, warehousing, insurance, shrinkage and obsolescence. It is the reason excess inventory is expensive even when nothing goes wrong.",
    howCalculated: "Stock value × annual carrying rate (22% used here, a standard distribution figure).",
    benchmark: "Carrying costs of 18–28% per year are typical. It means £1m of idle stock quietly costs ~£220k annually.",
  },

  // ── EXECUTE ──
  "Net Benefit": {
    meaning: "Whether a replenishment action is worth taking in pure cash terms — the stockout cost it averts, minus what it costs to expedite and to carry the stock.",
    howCalculated: "Stockout cost averted − expedite premium − holding cost over the lead time. Only critical actions are credited with averting a stockout.",
    benchmark: "Ranking actions by £ net benefit rather than by urgency alone stops the classic error of air-freighting cheap parts while a high-value item waits.",
  },
  "Cost to Serve": {
    meaning: "The full economic picture of a supply decision: holding cost, stockout penalty and expedite premium considered together rather than optimising cover-days in isolation.",
    howCalculated: "Holding 22%/yr of order value; stockout penalty 35% of unit cost per unit short (lost margin, emergency freight, goodwill); expedite premium 18% of order value.",
    benchmark: "Cover-day RAG tells you what is wrong; cost-to-serve tells you what is worth fixing first. Mature planning functions optimise the second.",
  },
  "Goods Receipt": {
    meaning: "Formally booking an inbound order into stock — the step that converts an in-transit promise into available inventory and closes the procure-to-pay loop.",
    howCalculated: "Confirms received quantity, issues a Goods Receipt Note (GRN) and performs a 3-way match between purchase order, receipt and invoice before payment is released.",
    benchmark: "The 3-way match is a core financial control: it is what prevents paying for goods that never arrived or were never ordered.",
  },

  // ── ORCHESTRATE ──
  "S&OP": {
    meaning: "Sales & Operations Planning — the monthly cycle that reconciles what the business intends to sell, what the supply chain can actually deliver, and what finance has budgeted. It is the tactical horizon that day-to-day replenishment cannot see.",
    howCalculated: "Projects demand per category over 6 months using seasonality, compares it against supply capability, and flags months where supply cannot cover demand.",
    benchmark: "Operational replenishment works in days; long-lead items need months. Heat-pump kits at 14–16 weeks cannot be fixed by a purchase order raised today — only by an S&OP decision made a quarter ago.",
  },
  "Constrained Allocation": {
    meaning: "When supply cannot meet demand, someone must decide who goes short. Allocation makes that choice explicit and fair rather than letting whoever orders first take everything.",
    howCalculated: "Available supply is distributed across sites in proportion to their share of demand; the unmet remainder is shown as a shortfall per site.",
    benchmark: "Without formal allocation, constrained supply is consumed first-come-first-served — which systematically starves the regions that plan properly.",
  },
  "Network Scenario Twin": {
    meaning: "A digital twin of the network used to rehearse disruption before it happens: apply a demand shock and a supply delay, and see exactly which SKUs break and what recovery would cost.",
    howCalculated: "Re-projects every position under the chosen shock without changing any live data. Reports SKUs tipping critical, total units short, and the expedited freight cost to recover.",
    benchmark: "Rehearsing a cold snap or a supplier failure in advance is how a control tower converts a crisis into a pre-agreed playbook.",
  },
  "Expedite Cost": {
    meaning: "What it would cost to recover from the simulated shortfall using emergency freight — the price of being caught out.",
    howCalculated: "Units short × unit cost × (1 + expedite premium). Compare this against the cost of simply holding a larger buffer.",
    benchmark: "If expedite exposure repeatedly exceeds the cost of carrying more buffer, the buffer is too small — that trade-off is the whole point of the simulation.",
  },

  // ── LEARN ──
  "Forecast Tuning": {
    meaning: "The feedback loop that keeps the model honest. Persistent forecast bias is not noise — it is a systematic error that should change how buffers are set.",
    howCalculated: "Tracks MAPE (size of error), bias (direction of error) and FVA (value the model adds over a naive guess) per SKU, then recommends a buffer adjustment where bias is persistent.",
    benchmark: "Over-forecasting inflates buffers and creates excess; under-forecasting causes stockouts. A closed loop back into safety stock is what separates a learning system from a static one.",
  },
  "MAPE": {
    meaning: "Mean Absolute Percentage Error — the average size of forecast error, regardless of direction. It measures precision.",
    howCalculated: "Average of |actual − forecast| ÷ actual across recent periods.",
    benchmark: "Under 12% is best-in-class for spare parts; 20%+ on volatile items is normal and is exactly why those items carry more safety stock.",
  },
  "Forecast Bias": {
    meaning: "The direction of forecast error — whether the model consistently over- or under-predicts. Bias is more damaging than random error because it compounds in one direction.",
    howCalculated: "Mean signed error as a percentage. Positive means over-forecasting; negative means under-forecasting.",
    benchmark: "Should sit within ±3%. Sustained positive bias quietly builds excess stock; sustained negative bias quietly builds stockout risk.",
  },
  "FVA": {
    meaning: "Forecast Value Added — how much accuracy the model actually adds over a naive 'same as last period' guess. It answers whether the forecasting effort is worth anything at all.",
    howCalculated: "Accuracy of the statistical model − accuracy of a naive last-period forecast.",
    benchmark: "Negative FVA means the model is worse than doing nothing — a surprisingly common and expensive finding in real planning teams.",
  },
  "Policy Nudge": {
    meaning: "The concrete buffer change that this SKU's forecast bias implies — the loop closing from measurement back into policy.",
    howCalculated: "Bias above +3% → trim safety stock (demand is over-predicted). Bias below −3% → raise safety stock. Otherwise hold.",
    benchmark: "Acting on bias is what turns forecast measurement from a report card into an improvement mechanism.",
  },
  "Inbound Transfers": {
    meaning: "Stock currently moving from the national distribution centre to this regional hub on an internal trunker run — supply already committed and on its way.",
    howCalculated: "Count and unit total of transfer orders with status picking or in-transit destined for the selected hub.",
    benchmark: "Hubs are replenished in 1–2 days from the NDC, versus days or months from a supplier — which is exactly why hubs can hold a much leaner buffer.",
  },
  "Demand Sensing Horizon": {
    meaning: "How far into the future a live signal is allowed to influence the forecast. Demand sensing is a SHORT-term layer: it sharpens the next fortnight, it must not distort the quarter.",
    howCalculated: "Signals apply at full weight for days 1–7, decay linearly to zero by day 21, and beyond that the forecast is pure statistical baseline (level × seasonality).",
    benchmark: "A Met Office forecast is credible ~7 days and useful to ~14. Applying a cold-snap uplift flat across 90 days is a classic modelling error — it inflates buffers for weather that was never forecast.",
  },
  "Stock Transport Order": {
    meaning: "The internal document a regional hub raises on the Leicester NDC to pull stock it needs. Hubs never buy from suppliers — a hub shortfall is a positioning problem, so it is solved by moving stock that already exists in the network.",
    howCalculated: "The RECEIVING plant (the hub) raises the STO on the supplying plant (the NDC). SAP document type UB with an NL replenishment delivery. The NDC picks and posts goods issue; the hub posts goods receipt on arrival.",
    benchmark: "Raising the order at the receiving plant is what makes the hub accountable for its own service level — and it is why an STO, unlike a PO, creates no new inventory in the network.",
  },
  "Model Input": {
    meaning: "This signal is wired into the demand forecast — it actively changes predicted demand and therefore what gets ordered.",
    howCalculated: "Scored against a reference level, scaled by an elasticity, and applied only to the product categories it genuinely drives.",
    benchmark: "A signal that is displayed but not wired into the model is decoration. Only weather and IoT currently drive this forecast.",
  },
  "Context Signal": {
    meaning: "Shown for situational awareness but deliberately NOT part of the demand model. It helps a planner interpret what they are seeing without silently influencing the numbers.",
    howCalculated: "Read directly from the source system and displayed as-is.",
    benchmark: "Separating model inputs from context is what keeps a forecast explainable — you can always answer 'what actually moved this number?'",
  },
  "Catalogue Size": {
    meaning: "The total number of SKUs under management. Scale changes the problem: at a handful of SKUs a planner can eyeball everything; at a thousand, only ranking and exception management work.",
    howCalculated: "Count of all active SKUs across all categories and sites.",
    benchmark: "Beyond ~200 SKUs, manual review stops scaling — which is why every list here is ranked by £ impact and every total is computed server-side.",
  },

  // ── Transport Control · arrival risk ───────────────────────────────────────
  // The three figures that sit beside "Jobs at Risk · Arrival" on the Routes tab
  // and the Executive Dashboard's Transport panel. They answer three different
  // questions about the same late rounds: how many appointments, how many of
  // those carry a contractual clock, and how far past the window the worst one is.
  // Worst Slip and Worst Breach are the SAME measure under two labels — the
  // Executive Dashboard's Transport panel calls it a slip, the Routes tab calls
  // it a breach. Both read the max across open arrival-risk rows, so the two
  // definitions are kept deliberately identical: if they ever say different
  // things, one of the two pages is lying about the same number.
  "Worst Slip": {
    meaning: "The single worst overshoot on the network right now — how many minutes past its committed window the worst-affected appointment is projected to arrive. One badly delayed round shows up here long before it moves the headline job count, which is what makes it an early warning rather than a tally.",
    howCalculated: "For each remaining stop on a round running 10+ minutes behind: projected arrival (planned arrival + the round's current delay) − the stop's committed deadline. The deadline is the planned arrival plus that job's grace — 15 min on a P1 emergency callout, 30 on a P2 repair, 60 on a routine service. This figure is the largest such overshoot anywhere on the network.",
    benchmark: "Under 15 minutes is usually recoverable by re-sequencing. At 45 minutes and above the round is graded high — and critical if any of its at-risk stops is a P1 or P2, because then the overshoot is against a contractual clock rather than a courtesy one.",
  },
  "Worst Breach": {
    meaning: "The single worst overshoot on the network right now — how many minutes past its committed window the worst-affected appointment is projected to arrive. The same measure the Executive Dashboard shows as Worst Slip.",
    howCalculated: "For each remaining stop on a round running 10+ minutes behind: projected arrival (planned arrival + the round's current delay) − the stop's committed deadline. The deadline is the planned arrival plus that job's grace — 15 min on a P1 emergency callout, 30 on a P2 repair, 60 on a routine service. This figure is the largest such overshoot anywhere on the network.",
    benchmark: "Under 15 minutes is usually recoverable by re-sequencing. At 45 minutes and above the round is graded high — and critical if any of its at-risk stops is a P1 or P2, because then the overshoot is against a contractual clock rather than a courtesy one.",
  },
  "SLA Jobs at Risk": {
    meaning: "Of the appointments projected to miss their window, the ones carrying a contractual commitment — P1 emergency callouts and P2 repairs. These are the breaches with money attached, so they decide which late round gets worked first.",
    howCalculated: "Sum of P1 and P2 stops across every open arrival-risk row. Routine service jobs are counted in the wider jobs-at-risk figure but excluded here.",
    benchmark: "Any non-zero value should be worked before a round with more jobs but no SLA on them — volume is not the same as exposure.",
  },
  "Engineers Late": {
    meaning: "Rounds currently projected to miss at least one booked appointment. A round can be behind schedule without appearing here — it only counts once the delay actually eats into a customer's window.",
    howCalculated: "Count of open arrival-risk rows: rounds 10 minutes or more behind with at least one remaining stop projected past its SLA deadline.",
    benchmark: "Traffic severity drives this: a normal day runs ~10% of live rounds behind, a severe weather day ~40%. Each one carries six costed recovery options.",
  },
  "Active Vans": {
    meaning: "Vans in service right now — roadworthy and either available, driving to a job, or on site. The live measure of field logistics capacity.",
    howCalculated: "Count of vans that are not VOR and whose status is available, en route or on site. Off-duty vans and vans on break are excluded.",
    benchmark: "Read alongside VOR: every vehicle off the road is capacity this number can never recover.",
  },
  "Electric Vans": {
    meaning: "Share of the van fleet that is fully electric — the lever behind CAZ exemption, Scope 1 reduction and lower running costs.",
    howCalculated: "EV vans ÷ total fleet × 100.",
    benchmark: "The UK ZEV mandate pushes new van sales to zero-emission by 2035. Leading utility fleets target 30% EV by 2027.",
  },
  "Avg Driver Score": {
    meaning: "Fleet-wide average of the per-driver telematics score (0–100). It moves slowly, so a fall of even two or three points means behaviour has changed across many drivers rather than one.",
    howCalculated: "Mean driver score across every van in the fleet, each scored from harsh braking, harsh acceleration, speeding and idling over the last 7 days.",
    benchmark: "Fleet average ≥82 correlates with lower insurance premiums. Individual drivers below 70 are the ones surfaced for coaching.",
  },
  "Fleet Fuel Cost": {
    meaning: "What running the whole fleet costs this month in fuel and charging combined — the direct cash consequence of route length, congestion and driving style.",
    howCalculated: "Σ of every van's month-to-date fuel or charging spend, from telematics-reported mileage priced at its fuel type's pence-per-mile.",
    benchmark: "EV vans run at roughly 7p/mile against ~18p for diesel, so this figure falls as the EV share rises even at constant mileage.",
  },
  "Fleet CO₂": {
    meaning: "Tailpipe CO₂ from the whole van fleet this month. This is Scope 1 — emissions the business produces directly, and the half of the carbon picture that electrification actually removes.",
    howCalculated: "Σ of every van's monthly tailpipe CO₂: diesel miles × 0.28 kg/mile. EV vans contribute zero here (their emissions sit in the grid, not the tailpipe).",
    benchmark: "Tracked against the Scope 1 reduction pathway alongside the EV transition. Route optimization and idling reduction are the levers available without replacing vehicles.",
  },

  // ── Transport Control · third-party carrier legs ───────────────────────────
  "Carriers In Flight": {
    meaning: "Third-party consignments currently moving out of the hubs into the forward network — booked, collected, in transit or out for delivery. Somebody else's vehicle, carrying our parts.",
    howCalculated: "Count of carrier movements not yet delivered or cancelled, across all three destination channels: ByBox locker, in-boot overnight, and two-man to the job address.",
    benchmark: "Volume tracks the day's parts demand. What matters is not the count but how many of them are behind promise.",
  },
  "Carrier Delays": {
    meaning: "Third-party legs running behind their promised time. The levers here are different from a late van — escalate, re-book with the standby carrier, split the consignment, divert, cover from hub, or move the customer — and none of them is 'drive faster'.",
    howCalculated: "Count of in-flight carrier movements with a delay against the promised time. Delivered consignments are excluded however late they ran.",
    benchmark: "Each delayed leg carries its own priced options. Bulky two-man consignments are the hard ones: they fit in neither a locker nor a boot, so they cannot be split or re-channelled.",
  },
  "Carrier On-Time": {
    meaning: "Share of in-flight third-party legs still running to promise — the health of the outsourced half of the network, which is the half we cannot simply re-plan.",
    howCalculated: "(In-flight movements − delayed movements) ÷ in-flight movements × 100.",
    benchmark: "≥90% is normal. Sustained dips usually trace to one carrier or one lane rather than a general problem, so check the delayed list before escalating network-wide.",
  },
  "Bulky In Flight": {
    meaning: "Two-man consignments currently moving — outdoor units, cylinders and full boiler swaps. They go direct to the customer address on the day because they fit in neither a locker nor a van boot.",
    howCalculated: "Count of in-flight carrier movements flagged bulky.",
    benchmark: "Bulky legs have the fewest recovery options: they cannot be split, cannot be re-pointed to a locker, and a miss usually means rebooking the installation.",
  },

  // ── Transport Control · one vehicle ────────────────────────────────────────
  "MOT Due": {
    meaning: "Days until this van's MOT certificate expires. Driving without a valid MOT invalidates insurance and risks a £1,000 fine, so the expiry date is a hard stop rather than a target.",
    howCalculated: "MOT expiry date − today, for this vehicle.",
    benchmark: "Book the slot at least 2 weeks ahead. At 0 days the van should be VOR immediately rather than dispatched.",
  },
  "Service In": {
    meaning: "Miles this van can still cover before its next scheduled service falls due. Running past the interval voids the manufacturer warranty and is what turns a routine service into a defect.",
    howCalculated: "Service interval mileage − miles driven since the last service, read from the vehicle's odometer.",
    benchmark: "Under 1,000 miles the van should be booked in — at typical field mileage that is about a fortnight of work.",
  },
  "EV Charge": {
    meaning: "State of charge on this electric van and the range it implies. Unlike a diesel, a low charge cannot be fixed in five minutes at a forecourt, so it constrains which jobs the van can still be given today.",
    howCalculated: "Battery percentage from the telematics unit, converted to range using the model's real-world consumption rather than its published figure.",
    benchmark: "Below 35% the van should not be assigned a long-distance job without a charging stop planned. Cold weather can cut usable range by 20–25%.",
  },
  "Harsh Braking": {
    meaning: "Harsh braking events recorded for this driver over the last 7 days. The strongest single predictor of collision risk in telematics data — it usually means following too closely rather than braking too hard.",
    howCalculated: "Count of decelerations beyond the telematics threshold in the trailing 7 days. Each event costs 2 points off the driver score.",
    benchmark: "Above 8 events a week is worth a coaching conversation; it also burns fuel and wears brakes and tyres faster.",
  },
  "Speeding Events": {
    meaning: "Occasions in the last 7 days where this van exceeded the posted limit. The highest-weighted item in the driver score, because it is the one with direct legal and licence consequences for the driver.",
    howCalculated: "Count of speed-limit exceedances from GPS speed matched against road-segment limits, trailing 7 days. Each event costs 4 points off the driver score.",
    benchmark: "More than 3 a week triggers a coaching conversation. Repeat offenders raise the fleet's insurance premium as well as their own risk.",
  },
  "Idling": {
    meaning: "Share of engine-on time this van spent stationary. Idling burns fuel and emits CO₂ while achieving nothing, and on a cold morning it is often habit rather than necessity.",
    howCalculated: "Idle minutes ÷ total engine-on minutes over the trailing 7 days, as a percentage. Each percentage point costs 0.5 off the driver score.",
    benchmark: "Under 12% is normal for field work with frequent stops. Above that is usually cab heating or DPF myths rather than genuine warm-up need.",
  },
  "Driven Today": {
    meaning: "Hours behind the wheel and miles covered by this van today — the driver's-hours and fatigue picture, and a sanity check on whether the round was realistically planned.",
    howCalculated: "Telematics engine-on driving time and odometer distance since midnight.",
    benchmark: "Above 4 hours driving is a heavy day for a field engineer: every hour driving is an hour not fixing, which is exactly what route optimization exists to reduce.",
  },
  "Vehicle Fuel Cost": {
    meaning: "What this one van has cost to fuel or charge so far this month — the per-vehicle view of the fleet running-cost figure.",
    howCalculated: "Month-to-date miles × pence-per-mile for this van's fuel type (diesel ~18p/mi, EV ~7p/mi).",
    benchmark: "Compare against the van's mileage before reading anything into it: a high-mileage van costing more is not a problem, a low-mileage one costing the same is.",
  },
  "Tailpipe CO₂": {
    meaning: "Scope 1 CO₂ emitted by this van this month. Electric vans read zero here — their emissions move to the grid, which is why the EV transition and the Scope 1 target are the same programme.",
    howCalculated: "Diesel miles this month × 0.28 kg CO₂/mile. EV vans return zero.",
    benchmark: "Feeds the fleet total and the People & Planet Plan Scope 1 pathway alongside route optimization.",
  },

  // ── Live Visibility · exception queue ──────────────────────────────────────
  // The dashboard strip shows a total and three priority counts. All four are
  // OPEN exceptions right now — not exceptions raised over a period.
  "P1 Exceptions": {
    meaning: "Open P1 exceptions — live incidents with direct customer impact, such as a 3PL site closure or an emergency callout that cannot be served. A P1 puts the whole network into a critical state.",
    howCalculated: "Count of exceptions with priority P1 and status open, right now.",
    benchmark: "Target: zero standing. First response is expected within 5 minutes; a breach at 15 minutes triggers executive escalation.",
  },
  "P2 Exceptions": {
    meaning: "Open P2 exceptions — serious issues with contractual or SLA consequence that are not yet customer-visible, such as a critical SKU stockout or a round about to miss an SLA appointment.",
    howCalculated: "Count of exceptions with priority P2 and status open, right now.",
    benchmark: "P2s left unowned are what become tomorrow's P1s. Each should have a named owner within the hour.",
  },
  "P3 Exceptions": {
    meaning: "Open P3 exceptions — operational problems that degrade service without breaching it yet, such as a cluster of pre-8AM locker misses or a warehouse running below its throughput baseline.",
    howCalculated: "Count of exceptions with priority P3 and status open, right now.",
    benchmark: "Work these within the shift. A rising P3 count with a flat P1 count usually means a systemic issue is building.",
  },

  // ── Live Visibility · action queues ────────────────────────────────────────
  "Van Stock Alerts": {
    meaning: "Engineers whose van is short of a part it is supposed to carry. Each alert arrives with four costed ways to close it — transfer from a nearby van, reallocate the job, collect en route, or replenish overnight — priced against live stock, so the queue never offers something the network cannot do.",
    howCalculated: "Count of open van-stock alerts: vans with at least one line below its per-van minimum. Severity is graded by how many stops are left on that round and whether any line has hit zero.",
    benchmark: "A clear queue is the normal state. What matters is not the alert count but the jobs it puts at risk — one alert on a round with six stops left costs more than three on rounds that are nearly done.",
  },
  "Pre-8AM Locker Misses": {
    meaning: "ByBox sites that did not take their overnight wave. Every one is an engineer standing in a car park at 07:40 with no part — and it has a short window in which it can still be fixed, which is why it carries its own resolutions rather than sitting in a report.",
    howCalculated: "Count of open pre-8AM miss records: locker sites where the overnight delivery was not confirmed by 08:00, with the reason (carrier no-show, hub dispatch failure, site access) attached.",
    benchmark: "Target zero. Options are failover to a healthy neighbouring site, a catch-up drop, or sending the engineer to collect from the hub — all of which get worse the later they are decided.",
  },
  "Jobs at Risk · Van Stock": {
    meaning: "Today's remaining appointments sitting on rounds that have an open van-stock alert. The alert count says how many vans are short; this says what that is costing in customer appointments.",
    howCalculated: "Σ of remaining stops across every open van-stock alert. Because there is no per-job parts list, this is an upper bound — some of those jobs will not need the missing part.",
    benchmark: "This is the number the alert queue is actually being worked to reduce, not the alert count itself.",
  },
  "Alerts Resolved": {
    meaning: "Van-stock alerts closed by a decision taken in this session — a transfer raised, a job reallocated, a collection inserted into a round, or an overnight replenishment booked.",
    howCalculated: "Count of alerts whose status moved to resolved since the session began. Each keeps its chosen option and its recorded outcome.",
    benchmark: "Resolutions move real state: a collection option inserts a stop into the engineer's route, which is why the map and the route view both change when one is applied.",
  },

  // ── Live Visibility · locker network ───────────────────────────────────────
  "Locker Network Health": {
    meaning: "Share of the ByBox locker estate operating normally — neither over-full nor waiting on a delivery. The single figure for whether the pre-8AM parts channel is working tonight.",
    howCalculated: "(Total locker sites − sites flagged for attention) ÷ total sites × 100. A site is flagged when its pre-8AM delivery is unconfirmed or it is more than 85% full.",
    benchmark: "≥95% is a healthy estate. Below 85% the channel is no longer dependable and van stock has to absorb the difference.",
  },

  // ── Live Visibility · 3PL site detail ──────────────────────────────────────
  "Courier OT Rate": {
    meaning: "Percentage of courier dispatches from this warehouse departing on or before their scheduled collection time. A late collection delays every engineer downstream of it, whatever the pick rate was.",
    howCalculated: "Courier collections on-time ÷ total scheduled collections × 100.",
    benchmark: "Target: ≥95%. Below 90% indicates dock congestion or staffing issues rather than a picking problem.",
  },
  "Staff Present": {
    meaning: "Operatives on shift at this site right now. It is the constraint behind the throughput figure — a site cannot pick its way out of an absence, and this is the first number to move in a labour event.",
    howCalculated: "Headcount clocked in for the current shift, permanent and agency combined.",
    benchmark: "Read against Labour Risk Score and Absenteeism: a falling headcount with a rising risk score is the shape of an industrial-relations problem, not a sickness spike.",
  },
  "Baseline Throughput": {
    meaning: "What this site is built to process per hour under normal operations — the denominator every throughput percentage on this page is measured against.",
    howCalculated: "Design capacity in items picked and dispatched per hour for the site, set from its equipment, layout and standard shift pattern.",
    benchmark: "Baselines differ by site, which is why the network figure is volume-weighted: one small site at 50% is not the same event as every site at 50%.",
  },

  // ── Live Visibility · site stock position ──────────────────────────────────
  "Units On Hand": {
    meaning: "Total physical units held at this site across every SKU — the stock actually in the building, whether or not it is allocated.",
    howCalculated: "Σ of on-hand quantity across all SKUs positioned at this warehouse.",
    benchmark: "Volume alone says little: a hub behind a 1-day trunker lane is meant to hold far less than the NDC, which pools the buffer for the whole network.",
  },
  "Days of Cover": {
    meaning: "How many days this site's stock will last at the current demand-adjusted consumption rate, averaged across its SKUs. The primary urgency indicator for the site.",
    howCalculated: "Σ (on hand ÷ adjusted daily consumption) ÷ SKU count. Weather and IoT demand uplifts raise consumption and shrink cover.",
    benchmark: "Cover below the site's own replenishment lead time means a stockout is already in flight — 1–2 days at a hub, the full supplier lead at the NDC.",
  },
}

export function getKPIDef(label: string): KPIDef | undefined {
  // API keys arrive snake_case (pre_8am_delivery_success); definitions are keyed
  // by display labels and space-separated lowercase — normalise before lookup.
  return (
    KPI_DEFINITIONS[label]
    ?? KPI_DEFINITIONS[label.toLowerCase()]
    ?? KPI_DEFINITIONS[label.replace(/_/g, ' ').toLowerCase()]
  )
}
