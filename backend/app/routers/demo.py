from fastapi import APIRouter
from pydantic import BaseModel
from app.services.response import ok
from app.services.websocket_manager import ws_manager
from app.synthetic.state import synthetic_state

router = APIRouter(prefix="/api/v1/demo", tags=["demo"])

# Each scenario carries a distinct AI risk plan. "immediate" IS the response
# playbook for that scenario — named, triggered, and numbered like a real
# incident-response runbook — followed by short-term and long-term actions.
# This plan is looked up by exceptions.scenario_id (surfaced in the Exception
# detail view) and by the Executive Dashboard's AI Insights panel while the
# scenario is active. "shipment_delay" is exception-only (no Simulator card)
# so day-to-day baseline exceptions also carry a real plan.
SCENARIO_META = {
    "normal": {
        "name": "Reset to Normal",
        "affected_modules": ["All"],
        "kpis_changed": ["All – restored to baseline"],
        # Steady state is not "no plan". It is the cheapest moment to recover
        # capital and buy resilience, so the agenda here is proactive rather than
        # reactive — the same three horizons, framed as improvement not response.
        "risk_plan": {
            "playbook_name": "Steady-State Improvement Agenda",
            "trigger": "No active incident — capacity available to improve",
            "risk_level": "None", "likelihood": "—", "impact": "—",
            "summary": "No incident is active and every KPI is inside tolerance. This is the window to clear the planner worklist, recover capital tied up in excess stock, and put the structural protections in place that a disruption will otherwise expose. Resilience bought now is far cheaper than resilience bought mid-crisis.",
            "immediate": [
                {"action": "Clear the planner worklist while there is spare capacity, working top-down by capital at risk", "owner": "Replenishment Planner", "by": "This shift", "impact": "Stops amber becoming red"},
                {"action": "Action the excess disposition backlog before it ages toward write-off", "owner": "Inventory Analyst", "by": "This week", "impact": "Recovers working capital"},
                {"action": "Verify A-class single-sourced lines hold cover through their full lead-time window", "owner": "Inventory Analyst", "by": "This week", "impact": "Confirms the buffer actually holds"},
                {"action": "Pre-position boiler parts at the NDC and Coventry ahead of the winter heating surge", "owner": "Supply Chain Director", "by": "Before October", "impact": "Beats the seasonal scramble"},
            ],
            "short_term": [
                {"action": "Retune forecast policy where bias is persistent — over-forecasting builds excess, under-forecasting builds stockouts", "owner": "Demand Planner", "by": "This quarter", "impact": "Closes the learning loop"},
                {"action": "Rebalance stock to correct echelon positioning across the network", "owner": "Inventory Analyst", "by": "This quarter", "impact": "Frees cash without cutting service"},
                {"action": "Begin secondary-source qualification on single-sourced A-class lines — during calm, not during disruption", "owner": "Procurement", "by": "This quarter", "impact": "A clause only protects you if exercised"},
                {"action": "Run the S&OP cycle against constrained long-lead capacity so commitments match what OEMs can deliver", "owner": "Supply Chain Director", "by": "Next S&OP cycle", "impact": "Prevents over-promising"},
            ],
            "long_term": [
                {"action": "Set a board-level working-capital and GMROI target for inventory", "owner": "Finance Director", "by": "2 quarters", "impact": "Makes inventory earn its keep"},
                {"action": "Adopt weather-indexed safety stock so winter buffers rise on forecast, not on incident", "owner": "Supply Chain Director", "by": "Before next winter", "impact": "Pre-empts the seasonal surge"},
                {"action": "Deploy supplier financial-health monitoring across tier-1 suppliers", "owner": "Procurement Director", "by": "2 quarters", "impact": "Insolvency is visible months ahead if watched"},
                {"action": "Run an unannounced NDC failover test and a joint cyber tabletop with the 3PL", "owner": "Supply Chain Director", "by": "Annually", "impact": "An untested plan is only an assumption"},
            ],
            "kpis_to_watch": ["Working capital", "GMROI", "Excess stock", "Open planner actions", "Supplier OTIF"],
        },
    },
    "locker_outage": {
        "name": "ByBox Locker Outage",
        "affected_modules": ["Live Visibility Hub", "Exceptions", "Analytics"],
        "kpis_changed": ["pre_8am_success_rate", "lockers healthy %"],
        "risk_plan": {
            "playbook_name": "Locker Network Outage Response",
            "trigger": "Locker telemetry/comms loss affecting 20+ sites in a region",
            "risk_level": "Low", "likelihood": "Likely", "impact": "Minor",
            "summary": "A ByBox comms fault takes ~40 North West lockers offline. Pre-8AM confirmation is lost for affected sites and ~55 engineers may arrive to unconfirmed stock. Master-key fallback keeps jobs moving; the risk is wasted engineer time, not failed jobs.",
            "immediate": [
                {"action": 'Push master-key fallback notice with the three nearest healthy sites to affected engineers', "owner": 'Field Dispatch', "by": 'T+15 min', "impact": 'Keeps ~55 engineers working'},
                {"action": "Divert tonight's pre-8AM wave for offline sites to adjacent healthy lockers", "owner": '3PL Ops', "by": 'Before 18:00 cut-off', "impact": 'Protects next-day first-time fix'},
                {"action": 'Raise a NOC ticket with ByBox and demand a restoration ETA', "owner": 'Supplier Manager', "by": 'T+30 min', "impact": 'Starts the SLA clock'},
                {"action": 'Hold automated routing to affected sites until each is manually confirmed recovered', "owner": '3PL Ops', "by": 'Until telemetry green', "impact": 'Prevents stock stranded at dead lockers'},
            ],
            "short_term": [
                {"action": 'Reconcile physical stock at every recovered site before re-enabling automated allocation', "owner": '3PL Ops', "by": 'Within 48h', "impact": 'Restores inventory accuracy'},
                {"action": 'Quantify engineer hours lost and recharge against the ByBox availability SLA', "owner": 'Supplier Manager', "by": '5 working days', "impact": 'Recovers cost of disruption'},
                {"action": 'Daily ByBox NOC review until the telemetry heartbeat is stable for 72h', "owner": 'Supplier Manager', "by": 'Daily', "impact": 'Prevents silent recurrence'},
            ],
            "long_term": [
                {"action": 'Renegotiate the ByBox contract to include an availability SLA with outage credits and a telemetry heartbeat obligation', "owner": 'Procurement Director', "by": 'Next contract review', "impact": "Makes downtime the supplier's cost"},
                {"action": 'Automate nearest-healthy-site failover so engineer re-routing needs no manual dispatch', "owner": 'Head of Digital', "by": '2 quarters', "impact": 'Removes the manual dispatch step'},
                {"action": 'Introduce a second locker provider in the highest-density regions', "owner": 'Procurement Director', "by": '12 months', "impact": 'Ends single-network dependency'},
            ],
            "kpis_to_watch": ["Pre-8AM success rate", "Lockers healthy %", "First Time Fix Rate"],
        },
    },
    "courier_shortage": {
        "name": "Agency Courier No-Show",
        "affected_modules": ["Live Visibility Hub", "Exceptions", "Transport Control", "Labour Risk", "Analytics"],
        "kpis_changed": ["expediting_cost_pct", "courier OT rate (MAN_HUB)", "agency staff % (MAN_HUB)"],
        "risk_plan": {
            "playbook_name": "Courier Capacity Shortfall Response",
            "trigger": "Scheduled courier crew fails to report for a depot shift",
            "risk_level": "Low", "likelihood": "Likely", "impact": "Minor",
            "summary": "An overnight agency courier crew fails to report at Manchester Hub. Courier on-time drops to ~75% and three trunk moves slip 2–5 hours. Contained to one region and one shift if the standby contract is called promptly.",
            "immediate": [
                {"action": 'Call off the standby courier contract for the affected shift', "owner": 'Transport Manager', "by": 'T+30 min', "impact": 'Recovers ~3 trunk moves'},
                {"action": 'Re-sequence the reduced replenishment run by van-stock severity, not depot order', "owner": 'Transport Manager', "by": 'Before dispatch', "impact": 'Protects the most at-risk engineers'},
                {"action": 'Notify engineers whose morning stock will land late, with an expected time', "owner": 'Field Dispatch', "by": 'Before 06:00', "impact": 'Avoids wasted travel'},
                {"action": 'Log the no-show formally against the agency SLA for penalty recovery', "owner": 'Supplier Manager', "by": 'Same day', "impact": 'Preserves the contractual claim'},
            ],
            "short_term": [
                {"action": 'Clear the trunk backlog within 24h before it compounds into a second shift', "owner": 'Transport Manager', "by": '24h', "impact": 'Stops cascade into next day'},
                {"action": "Review the agency's 90-day no-show record; issue a formal performance notice if repeated", "owner": 'Supplier Manager', "by": '10 days', "impact": 'Addresses the pattern, not the incident'},
                {"action": 'Recover SLA penalties and reflect the cost in the next rate review', "owner": 'Procurement', "by": 'Next billing cycle', "impact": 'Recovers disruption cost'},
            ],
            "long_term": [
                {"action": 'Dual-source agency courier coverage at every hub so no single crew failure stops a depot', "owner": 'Procurement Director', "by": '6 months', "impact": 'Removes single-crew dependency'},
                {"action": 'Write a 12-hour no-show notice requirement with liquidated damages into all agency contracts', "owner": 'Procurement Director', "by": 'Next contract cycle', "impact": 'Shifts risk to the provider'},
                {"action": 'Bring core overnight trunk runs in-house, using agency only for peak flex', "owner": 'Transport Director', "by": '12 months', "impact": 'Protects the critical path'},
            ],
            "kpis_to_watch": ["Courier OT rate", "Van stock alerts", "Expediting cost %", "Agency staff dependency"],
        },
    },
    "supplier_otif_dip": {
        "name": "Supplier OTIF Dip",
        "affected_modules": ["3PL & Supplier Risk", "Exceptions", "Analytics"],
        "kpis_changed": ["supplier_otif"],
        "risk_plan": {
            "playbook_name": "Supplier Performance Watch",
            "trigger": "Supplier OTIF below target for 2+ consecutive weeks",
            "risk_level": "Low", "likelihood": "Very likely", "impact": "Minor",
            "summary": "Samsung HA OTIF slips to 78% for a second week. No supply gap yet — cover exceeds lead time — but sustained decline compounds quietly: each missed week erodes days-of-supply that winter demand will expose.",
            "immediate": [
                {"action": 'Request written capacity confirmation and a recovery plan from the supplier', "owner": 'Supplier Manager', "by": 'T+24h', "impact": 'Establishes intent on record'},
                {"action": 'Re-validate delivery promises on every open PO with this supplier', "owner": 'Replenishment Planner', "by": 'T+24h', "impact": 'Exposes hidden slippage'},
                {"action": 'Place the supplier on the active OTIF watch-list with weekly reporting', "owner": 'Supplier Manager', "by": 'Same day', "impact": 'Starts formal monitoring'},
            ],
            "short_term": [
                {"action": 'Raise buffer cover on SKUs this supplier single-sources until OTIF recovers above 90%', "owner": 'Inventory Analyst', "by": '2 weeks', "impact": 'Absorbs continued unreliability'},
                {"action": 'Begin qualification of a secondary source for the affected lines', "owner": 'Procurement', "by": 'Start within 30 days', "impact": 'Creates an exit option'},
                {"action": "Run a joint root-cause review with the supplier's operations lead", "owner": 'Supplier Manager', "by": '3 weeks', "impact": 'Fixes cause, not symptom'},
            ],
            "long_term": [
                {"action": 'Link commercial terms to OTIF performance, with rebates earned rather than assumed', "owner": 'Procurement Director', "by": 'Next contract review', "impact": 'Aligns supplier economics to service'},
                {"action": 'Deploy supplier financial-health monitoring so credit deterioration is seen before it becomes a delivery failure', "owner": 'Procurement Director', "by": '2 quarters', "impact": 'Turns a lagging signal into a leading one'},
                {"action": 'Mandate dual-sourcing for every single-sourced A-class SKU', "owner": 'Supply Chain Director', "by": '12 months', "impact": 'Structurally removes single points of failure'},
            ],
            "kpis_to_watch": ["Supplier OTIF", "Days of Supply (HP SKUs)", "Open PO delivery promises"],
        },
    },
    "shipment_delay": {
        "name": "Inbound Shipment ETA Deviation",
        "affected_modules": ["Demand & Inventory", "Exceptions"],
        "kpis_changed": ["first_time_fix_rate", "in_boot_availability"],
        "risk_plan": {
            "playbook_name": "Inbound Shipment Delay Response",
            "trigger": "Single inbound shipment ETA deviation > 4 hours",
            "risk_level": "Low", "likelihood": "Occasional", "impact": "Minor",
            "summary": "A single inbound shipment of Navien heat exchangers is running 8+ hours late due to port congestion at Tilbury. A modest number of today's jobs need this part — contained if stock is rerouted quickly from Manchester Hub.",
            "immediate": [
                {"action": 'Identify jobs booked against the delayed line and reroute stock from the nearest holding site', "owner": 'Replenishment Planner', "by": 'T+1h', "impact": "Saves today's affected jobs"},
                {"action": 'Reschedule any job that cannot be covered, before the engineer travels', "owner": 'Field Dispatch', "by": 'Before 07:00', "impact": 'Avoids failed first visits'},
                {"action": 'Obtain a firm revised ETA from the carrier and update the inbound record', "owner": 'Transport Manager', "by": 'T+2h', "impact": 'Restores planning confidence'},
            ],
            "short_term": [
                {"action": 'Run a root-cause review with the carrier on the ETA deviation', "owner": 'Transport Manager', "by": '5 days', "impact": 'Prevents repeat'},
                {"action": 'Recalibrate the ETA model for this lane if deviation exceeds 4h twice in 30 days', "owner": 'Head of Digital', "by": '2 weeks', "impact": 'Improves forward planning accuracy'},
                {"action": 'Review whether the affected SKUs warrant additional in-transit cover', "owner": 'Inventory Analyst', "by": '2 weeks', "impact": 'Right-sizes the buffer'},
            ],
            "long_term": [
                {"action": 'Introduce a carrier scorecard weighting ETA accuracy alongside cost in lane awards', "owner": 'Procurement', "by": 'Next tender', "impact": 'Buys reliability, not just price'},
                {"action": 'Hold additional cover on lines whose only route is long-haul sea freight', "owner": 'Inventory Analyst', "by": 'Next policy review', "impact": 'Buffers structural lead-time risk'},
            ],
            "kpis_to_watch": ["First Time Fix Rate", "In-boot availability"],
        },
    },
    "p1_3pl_closure": {
        "name": "P1: 3PL Site Closure",
        "affected_modules": ["Visibility Hub", "Exceptions", "3PL & Supplier Risk", "Labour Risk", "Transport Control", "Analytics"],
        "kpis_changed": ["first_time_fix_rate", "expediting_cost_pct", "pre_8am_success_rate", "labour risk score (LEI_COE)"],
        "risk_plan": {
            "playbook_name": "3PL Site Failover",
            "trigger": "Primary 3PL site throughput < 40% baseline for 60+ minutes",
            "risk_level": "High", "likelihood": "Possible", "impact": "Severe",
            "summary": "Primary 3PL site drops to 15% throughput. Pre-8AM locker deliveries and van replenishment fail within one cycle; FTFR falls to 61% as engineers arrive without parts. Regional traffic disruption slows re-routing.",
            "immediate": [
                {"action": 'Invoke the 3PL business continuity plan and stand up an incident bridge with TVS SCS', "owner": 'Supply Chain Director', "by": 'T+15 min', "impact": 'Single point of control'},
                {"action": 'Divert all inbound supplier deliveries to the alternate hub', "owner": '3PL Ops', "by": 'T+1h', "impact": 'Stops goods arriving at a closed door'},
                {"action": 'Re-point hub STOs to source from Coventry while Leicester is down', "owner": 'Replenishment Planner', "by": 'T+2h', "impact": 'Keeps hubs replenished'},
                {"action": 'Protect P1 and vulnerable-customer jobs first from remaining accessible stock', "owner": 'Field Dispatch', "by": 'T+2h', "impact": 'Protects the most exposed customers'},
                {"action": 'Brief the executive team and agree external customer messaging', "owner": 'Supply Chain Director', "by": 'T+3h', "impact": 'Controls the narrative'},
            ],
            "short_term": [
                {"action": 'Drive restoration against a 72-hour recovery benchmark, with a daily executive bridge', "owner": 'Supply Chain Director', "by": '72h', "impact": 'Enterprise-grade recovery standard'},
                {"action": 'Build and execute a backlog recovery plan for jobs deferred during closure', "owner": 'Field Ops Director', "by": 'Within 5 days', "impact": 'Clears the customer debt'},
                {"action": 'Quantify the financial impact and open a claim under the 3PL contract', "owner": 'Procurement Director', "by": '10 working days', "impact": 'Recovers loss'},
                {"action": 'Re-balance stock across the network once Leicester reopens', "owner": 'Replenishment Planner', "by": 'Within 7 days', "impact": 'Restores correct positioning'},
            ],
            "long_term": [
                {"action": 'Write a contractual Recovery Time Objective with financial penalties into the 3PL agreement', "owner": 'Procurement Director', "by": 'Next contract review', "impact": 'Makes recovery speed enforceable'},
                {"action": 'Build genuine geographic redundancy so no single site failure can halt the network', "owner": 'Supply Chain Director', "by": '12–18 months', "impact": 'Removes the single point of failure'},
                {"action": 'Run an annual unannounced failover test of the NDC contingency plan', "owner": 'Supply Chain Director', "by": 'Annually', "impact": "Proves the plan works before it's needed"},
                {"action": 'Hold a strategic reserve of the top critical SKUs outside the NDC', "owner": 'Inventory Analyst', "by": '2 quarters', "impact": 'Survives a total NDC loss'},
            ],
            "kpis_to_watch": ["Pre-8AM success rate", "First Time Fix Rate", "Expediting cost %", "Labour risk score (LEI_COE)"],
        },
    },
    "p2_stockout": {
        "name": "P2: Critical Stockout",
        "affected_modules": ["Demand & Inventory", "Exceptions", "Live Visibility Hub", "Labour Risk", "Analytics"],
        "kpis_changed": ["first_time_fix_rate", "expediting_cost_pct", "in_boot_availability"],
        "risk_plan": {
            "playbook_name": "Critical Stockout Response",
            "trigger": "Top-50 SKU reaches zero stock across all warehouses",
            "risk_level": "High", "likelihood": "Possible", "impact": "Major",
            "summary": "Diverter valves at zero stock across all hubs. Every boiler-repair job needing the part fails first visit; FTFR trends to 64% and emergency purchasing costs spike.",
            "immediate": [
                {"action": 'Sweep van stock network-wide and redistribute remaining units to P1 and vulnerable-customer jobs', "owner": 'Field Dispatch', "by": 'T+1h', "impact": 'Protects the most exposed jobs'},
                {"action": 'Raise an emergency PO with the fastest-available supplier, accepting the freight premium', "owner": 'Replenishment Planner', "by": 'T+2h', "impact": 'Restarts supply'},
                {"action": 'Contact customers with affected bookings before the engineer travels', "owner": 'Customer Ops', "by": 'Before next wave', "impact": 'Avoids failed visits'},
                {"action": 'Check sister-hub stock for a lateral rebalance before buying new', "owner": 'Replenishment Planner', "by": 'T+2h', "impact": 'Uses stock already owned'},
            ],
            "short_term": [
                {"action": 'Expedite the inbound PO and confirm the delivery promise daily until landed', "owner": 'Replenishment Planner', "by": 'Daily until receipt', "impact": 'Closes the exposure'},
                {"action": 'Run a root-cause review on why the buffer failed — forecast miss, lead-time slip, or policy error', "owner": 'Inventory Analyst', "by": 'Within 10 days', "impact": 'Distinguishes cause from symptom'},
                {"action": 'Re-run safety stock for the affected line against its true demand and lead-time variability', "owner": 'Inventory Analyst', "by": '2 weeks', "impact": 'Right-sizes the buffer'},
            ],
            "long_term": [
                {"action": 'Move critical single-sourced SKUs from just-in-time to a just-in-case buffer policy', "owner": 'Supply Chain Director', "by": 'Next policy review', "impact": 'Trades a little cash for service certainty'},
                {"action": 'Mandate dual-sourcing on every A-class SKU with a single supplier', "owner": 'Procurement Director', "by": '12 months', "impact": 'Removes the structural dependency'},
                {"action": 'Review service-level targets by ABC/XYZ segment so buffers reflect commercial value, not averages', "owner": 'Supply Chain Director', "by": '2 quarters', "impact": 'Puts cash where service matters'},
            ],
            "kpis_to_watch": ["Days of Supply", "In-boot availability", "First Time Fix Rate", "Expediting cost %", "Overtime % (LEI_COE)"],
        },
    },
    "beast_from_east": {
        "name": "Beast from East",
        "affected_modules": ["Demand & Inventory", "IoT & Smart Tech", "Exceptions", "Transport Control", "Labour Risk", "Analytics"],
        "kpis_changed": ["expediting_cost_pct", "scope3_ytd_tco2e", "traffic severity"],
        "risk_plan": {
            "playbook_name": "Severe Weather Surge Response",
            "trigger": "Met Office cold-snap alert combined with demand uplift factor > 1.35",
            "risk_level": "High", "likelihood": "Seasonal", "impact": "Major",
            "summary": "Extreme cold multiplies boiler demand ×1.42 and fault signals +45% while roads degrade to severe traffic, 8 vans suffer weather damage and EV range drops ~30%. Demand spikes exactly when transport capacity shrinks.",
            "immediate": [
                {"action": 'Pre-position condensate and diverter-valve stock to hubs in the coldest regions', "owner": 'Replenishment Planner', "by": 'T+4h', "impact": 'Puts parts where failures will happen'},
                {"action": 'Switch routing to cold-weather mode: shorter rounds, priority to vulnerable customers', "owner": 'Transport Manager', "by": 'Before next wave', "impact": 'Protects safety-critical jobs'},
                {"action": 'Open emergency engineer capacity — overtime and deferred non-urgent work', "owner": 'Field Ops Director', "by": 'T+6h', "impact": 'Adds capacity where demand spikes'},
                {"action": 'Raise emergency POs on the boiler lines the weather model shows spiking', "owner": 'Replenishment Planner', "by": 'Same day', "impact": 'Buys ahead of the surge'},
                {"action": 'Issue proactive customer comms on extended response times', "owner": 'Customer Ops', "by": 'T+6h', "impact": 'Manages expectations early'},
            ],
            "short_term": [
                {"action": 'Rebuild depleted buffers across all boiler lines as the cold snap eases', "owner": 'Replenishment Planner', "by": 'Within 10 days', "impact": 'Restores readiness'},
                {"action": 'Clear the accumulated job backlog with planned overtime', "owner": 'Field Ops Director', "by": '2 weeks', "impact": 'Recovers the customer debt'},
                {"action": 'Review which weather triggers fired correctly and which missed', "owner": 'Head of Digital', "by": '3 weeks', "impact": 'Sharpens the model for next event'},
            ],
            "long_term": [
                {"action": 'Adopt weather-indexed safety stock so buffers rise automatically ahead of forecast cold', "owner": 'Inventory Analyst', "by": 'Before next winter', "impact": 'Pre-empts rather than reacts'},
                {"action": 'Agree seasonal pre-build volumes with boiler-part suppliers ahead of each winter', "owner": 'Procurement Director', "by": 'Annually, by September', "impact": 'Secures capacity before competitors'},
                {"action": 'Formalise a cold-snap playbook with Met Office trigger thresholds and pre-agreed authority to spend', "owner": 'Supply Chain Director', "by": 'Before next winter', "impact": 'Removes decision delay in a crisis'},
                {"action": 'Build a winter surge engineer pool contracted for seasonal peak', "owner": 'Field Ops Director', "by": 'Before next winter', "impact": 'Adds capacity without year-round cost'},
            ],
            "kpis_to_watch": ["Demand uplift factor", "Days of Supply", "VOR count", "Traffic delay minutes", "Absenteeism rate (network)"],
        },
    },
    "supplier_insolvency": {
        "name": "Supplier Insolvency",
        "affected_modules": ["3PL & Supplier Risk", "Demand & Inventory", "Exceptions", "Analytics"],
        "kpis_changed": ["supplier_otif", "expediting_cost_pct"],
        "risk_plan": {
            "playbook_name": "Supplier Insolvency Contingency",
            "trigger": "Tier-1 supplier financial-health flag raised",
            "risk_level": "High", "likelihood": "Unlikely", "impact": "Major",
            "summary": "Mitsubishi HVAC financial distress flag — heat pump supply suspended pending administrator confirmation. Installation pipeline at risk within the 98-day lead time horizon.",
            "immediate": [
                {"action": 'Secure all stock already in transit and take physical possession where contractually entitled', "owner": 'Supply Chain Director', "by": 'T+2h', "impact": 'Protects goods you have paid for'},
                {"action": 'Freeze further payments and enforce retention-of-title and set-off rights', "owner": 'Finance Director', "by": 'T+2h', "impact": 'Limits financial exposure'},
                {"action": "Secure company-owned tooling, moulds and IP held at the supplier's site", "owner": 'Procurement Director', "by": 'T+4h', "impact": 'Tooling is near-impossible to recover post-administration'},
                {"action": 'Quantify total exposure: open POs, prepayments, and single-sourced lines at risk', "owner": 'Finance Director', "by": 'Same day', "impact": 'Sizes the problem for the board'},
                {"action": "Suspend new bookings dependent on this supplier's lines", "owner": 'Sales Ops', "by": 'Same day', "impact": 'Stops selling what cannot be delivered'},
            ],
            "short_term": [
                {"action": 'Open negotiations with the administrators for priority allocation of finished stock', "owner": 'Procurement Director', "by": 'Within 5 days', "impact": 'Competes for scarce remaining supply'},
                {"action": 'Fast-track qualification of the pre-identified alternate supplier', "owner": 'Procurement', "by": '30 days', "impact": 'Restores supply continuity'},
                {"action": 'Physically transfer tooling to the alternate supplier once released', "owner": 'Procurement Director', "by": '45 days', "impact": 'Enables production restart'},
                {"action": 'Re-plan the affected programme against realistic new lead times', "owner": 'Supply Chain Director', "by": '2 weeks', "impact": 'Resets commitments honestly'},
            ],
            "long_term": [
                {"action": 'Run continuous financial-health monitoring on all tier-1 suppliers with credit-deterioration alerts', "owner": 'Procurement Director', "by": '2 quarters', "impact": 'Insolvency is visible months ahead if watched'},
                {"action": 'Place tooling and IP in escrow, or hold duplicate tooling, for every sole-source supplier', "owner": 'Procurement Director', "by": '12 months', "impact": 'Makes recovery possible next time'},
                {"action": 'Enforce the dual-sourcing clause before disruption, not after — an unexercised clause gives no protection', "owner": 'Supply Chain Director', "by": '12 months', "impact": 'Diversification only works if actually used'},
                {"action": 'Reduce single-source exposure on A-class lines to an agreed board-level threshold', "owner": 'Supply Chain Director', "by": '18 months', "impact": 'Caps concentration risk'},
            ],
            "kpis_to_watch": ["Supplier OTIF", "Heat pump pipeline coverage", "Expediting cost %"],
        },
    },
    "heat_pump_surge": {
        "name": "Heat Pump Install Surge",
        "affected_modules": ["Demand & Inventory", "IoT & Smart Tech", "Exceptions", "Labour Risk", "Analytics"],
        "kpis_changed": ["expediting_cost_pct"],
        "risk_plan": {
            "playbook_name": "Demand Surge Capacity Management",
            "trigger": "CPQ pipeline growth >5x baseline against constrained OEM lead time",
            "risk_level": "Medium", "likelihood": "Likely", "impact": "Moderate",
            "summary": "Government grant expansion multiplies the CPQ pipeline ×8.1. Heat pump inventory falls to 3 units against a 98-day lead time — a demand opportunity that becomes a reputational risk if installs are booked without stock.",
            "immediate": [
                {"action": 'Cap new install bookings to the confirmed-stock horizon', "owner": 'Sales Ops', "by": 'T+2h', "impact": 'Stops selling beyond supply'},
                {"action": 'Allocate remaining kit to committed installs by customer commitment date', "owner": 'Replenishment Planner', "by": 'T+4h', "impact": 'Honours existing promises first'},
                {"action": 'Brief sales on what can actually be promised and by when', "owner": 'Supply Chain Director', "by": 'Same day', "impact": 'Prevents further over-commitment'},
            ],
            "short_term": [
                {"action": 'Run formal constrained allocation across regions rather than first-come-first-served', "owner": 'Supply Chain Director', "by": 'Within 5 days', "impact": 'Stops well-planned regions being starved'},
                {"action": 'Press OEMs for incremental capacity and earlier HGV slots', "owner": 'Procurement', "by": '2 weeks', "impact": 'Buys headroom against a 14–16 week lead'},
                {"action": 'Re-forecast the grant-driven pipeline and reset the install plan against real capacity', "owner": 'Demand Planner', "by": '2 weeks', "impact": 'Aligns the plan to reality'},
            ],
            "long_term": [
                {"action": 'Move heat-pump supply onto take-or-pay capacity contracts with OEMs', "owner": 'Procurement Director', "by": 'Next contract cycle', "impact": 'Secures capacity ahead of demand'},
                {"action": 'Build grant and policy signals into the S&OP demand plan as a leading indicator', "owner": 'Demand Planner', "by": '2 quarters', "impact": 'Sees the surge before it arrives'},
                {"action": 'Qualify an additional heat-pump OEM to reduce three-supplier concentration', "owner": 'Procurement Director', "by": '12 months', "impact": 'Adds capacity optionality'},
            ],
            "kpis_to_watch": ["Pipeline coverage ratio", "Days of Supply (HP SKUs)", "Booking-to-install lag", "Overtime % (LEI_COE)"],
        },
    },
    "port_congestion": {
        "name": "Port Congestion (Felixstowe)",
        "affected_modules": ["Demand & Inventory", "3PL & Supplier Risk", "Exceptions", "Transport Control", "Analytics"],
        "kpis_changed": ["supplier_otif", "expediting_cost_pct", "lead times ×1.6"],
        "risk_plan": {
            "playbook_name": "Port Congestion Mitigation",
            "trigger": ">48h berth dwell time reported at the primary import port",
            "risk_level": "High", "likelihood": "Likely", "impact": "Major",
            "summary": "Berth congestion delays 100% of sea freight 5–9 days and stretches Far-East lead times ×1.6. Days-of-supply erodes silently on imported SKUs — the damage appears 2–3 weeks later as stockouts.",
            "immediate": [
                {"action": 'Identify every SKU on the delayed vessels and flag those with under 3 weeks of cover', "owner": 'Replenishment Planner', "by": 'T+2h', "impact": 'Separates urgent from noise'},
                {"action": 'Air-freight only the lines that would otherwise stock out before the vessel clears', "owner": 'Supply Chain Director', "by": 'T+4h', "impact": 'Targets premium spend where it pays'},
                {"action": 'Notify programme owners of realistic revised landing dates', "owner": 'Supply Chain Director', "by": 'Same day', "impact": 'Prevents downstream over-commitment'},
            ],
            "short_term": [
                {"action": 'Extend planning lead times on all sea-freight lanes while congestion persists', "owner": 'Demand Planner', "by": 'Within 5 days', "impact": 'Stops the plan assuming normal transit'},
                {"action": 'Evaluate an alternate port of entry for the most exposed lines', "owner": 'Transport Director', "by": '3 weeks', "impact": 'Creates a route around the bottleneck'},
                {"action": 'Track and challenge demurrage and detention charges', "owner": 'Finance', "by": 'Ongoing', "impact": 'Congestion cost lands well before the stockout'},
            ],
            "long_term": [
                {"action": 'Establish dual-port routing for all Far East imports', "owner": 'Transport Director', "by": '12 months', "impact": 'Removes single-gateway dependency'},
                {"action": 'Hold structurally higher cover on sea-freight-only components', "owner": 'Inventory Analyst', "by": 'Next policy review', "impact": 'Buffers irreducible transit risk'},
                {"action": 'Assess nearshoring for the highest-value, most congestion-exposed lines', "owner": 'Supply Chain Director', "by": '18 months', "impact": 'Shortens the exposure permanently'},
            ],
            "kpis_to_watch": ["Inbound delay days", "Days of Supply", "Supplier OTIF", "Expediting cost %"],
        },
    },
    "cyber_incident": {
        "name": "Cyber Incident at 3PL",
        "affected_modules": ["Live Visibility Hub", "Exceptions", "3PL & Supplier Risk", "Transport Control", "Labour Risk", "Analytics"],
        "kpis_changed": ["pre_8am_success_rate", "first_time_fix_rate", "warehouse throughput"],
        "risk_plan": {
            "playbook_name": "Cyber Incident Response",
            "trigger": "Suspected or confirmed compromise of a 3PL/warehouse system",
            "risk_level": "Critical", "likelihood": "Possible", "impact": "Severe",
            "summary": "Ransomware takes the Leicester WMS offline: automated picking, ASN feeds and locker telemetry lost. Throughput drops to 31% on manual processes and digital walkaround submissions fail. Trust in stock accuracy degrades hourly.",
            "immediate": [
                {"action": 'Isolate affected WMS systems and invoke the cyber incident response plan', "owner": 'CISO', "by": 'T+15 min', "impact": 'Contains lateral spread'},
                {"action": 'Switch the affected site to documented manual pick-and-despatch fallback', "owner": '3PL Ops', "by": 'T+1h', "impact": 'Keeps goods moving without the system'},
                {"action": 'Freeze automated inventory postings to prevent corrupt data propagating', "owner": 'Head of Digital', "by": 'T+30 min', "impact": 'Protects data integrity'},
                {"action": 'Stand up executive and legal briefing, including regulator notification assessment', "owner": 'CISO', "by": 'T+2h', "impact": 'Meets the 72-hour GDPR clock'},
                {"action": 'Move critical outbound to the unaffected site', "owner": '3PL Ops', "by": 'T+3h', "impact": 'Preserves customer service'},
            ],
            "short_term": [
                {"action": 'Restore from verified clean backups only after integrity validation', "owner": 'Head of Digital', "by": 'As forensics permit', "impact": 'Avoids re-infection'},
                {"action": 'Run a full physical stock count to re-establish inventory accuracy before automation resumes', "owner": '3PL Ops', "by": 'Within 7 days', "impact": 'Accuracy fell to ~84% during manual running'},
                {"action": 'Complete customer and regulator notifications as legally required', "owner": 'Legal', "by": '72h', "impact": 'Meets statutory obligation'},
                {"action": 'Clear the despatch backlog accumulated during manual operation', "owner": '3PL Ops', "by": '10 days', "impact": 'Recovers service'},
            ],
            "long_term": [
                {"action": 'Segment the WMS network so a single compromise cannot halt all sites', "owner": 'CISO', "by": '2 quarters', "impact": 'Limits blast radius'},
                {"action": 'Write security standards, audit rights and breach-notification duties into all 3PL contracts', "owner": 'Procurement Director', "by": 'Next contract review', "impact": 'Makes supplier security enforceable'},
                {"action": 'Maintain and drill an offline fallback capability at every site', "owner": '3PL Ops', "by": '2 quarters', "impact": 'Manual mode only works if practised'},
                {"action": 'Run annual joint cyber tabletop exercises with the 3PL', "owner": 'CISO', "by": 'Annually', "impact": 'Tests the plan against the partner who must execute it'},
            ],
            "kpis_to_watch": ["Warehouse throughput %", "Pre-8AM success rate", "Stock accuracy variance", "Walkaround compliance", "Overtime % (LEI_COE)"],
        },
    },
    "fuel_crisis": {
        "name": "National Fuel Crisis",
        "affected_modules": ["Transport Control", "Live Visibility Hub", "Exceptions", "Labour Risk", "Analytics"],
        "kpis_changed": ["expediting_cost_pct", "pre_8am_success_rate", "VOR count"],
        "risk_plan": {
            "playbook_name": "Fuel Disruption Response",
            "trigger": "Regional forecourt fuel shortage affecting fleet refuelling",
            "risk_level": "High", "likelihood": "Unlikely", "impact": "Major",
            "summary": "Forecourt shortages ground 14 diesel vans and force fuel-priority routing for 90 engineers. Courier partners degrade simultaneously. The EV fleet becomes the resilient capacity — proving the transition case.",
            "immediate": [
                {"action": 'Prioritise remaining fuel allocation to P1, vulnerable-customer and safety-critical jobs', "owner": 'Transport Manager', "by": 'T+1h', "impact": 'Protects what matters most'},
                {"action": 'Consolidate routes and defer all non-essential mileage', "owner": 'Transport Manager', "by": 'Before next wave', "impact": 'Extends available range'},
                {"action": 'Switch EV-capable work to electric vans where charge permits', "owner": 'Field Dispatch', "by": 'Same day', "impact": 'Removes those jobs from fuel demand'},
                {"action": 'Confirm depot bulk-fuel reserves and ration against the priority list', "owner": 'Transport Director', "by": 'T+4h', "impact": 'Establishes true remaining capacity'},
            ],
            "short_term": [
                {"action": 'Secure a priority commercial fuel allocation with the bulk supplier', "owner": 'Procurement', "by": 'Within 5 days', "impact": 'Buys certainty during scarcity'},
                {"action": 'Re-plan engineer territories to minimise travel until supply normalises', "owner": 'Field Ops Director', "by": 'Within 7 days', "impact": 'Structurally cuts fuel demand'},
                {"action": 'Recover deferred jobs on a planned catch-up schedule', "owner": 'Field Ops Director', "by": '2 weeks', "impact": 'Clears the backlog'},
            ],
            "long_term": [
                {"action": 'Negotiate priority-supply fuel contracts with guaranteed allocation in shortage conditions', "owner": 'Procurement Director', "by": 'Next contract cycle', "impact": 'Converts scarcity risk into a contract term'},
                {"action": 'Accelerate EV transition in the highest-mileage regions', "owner": 'Transport Director', "by": '12–24 months', "impact": 'Structurally reduces fuel dependency'},
                {"action": 'Install depot fuel storage at the primary hubs to hold a strategic reserve', "owner": 'Transport Director', "by": '12 months', "impact": 'Provides a buffer against national disruption'},
            ],
            "kpis_to_watch": ["VOR count", "Miles avoided", "EV fleet %", "Pre-8AM success rate", "Absenteeism rate (network)"],
        },
    },
}


class ScenarioRequest(BaseModel):
    scenario_id: str


@router.post("/scenario")
async def apply_scenario(req: ScenarioRequest):
    result = synthetic_state.apply_scenario(req.scenario_id)
    meta = SCENARIO_META.get(req.scenario_id, {})

    # Broadcast state changes to all WebSocket channels immediately
    snapshot = synthetic_state.get_snapshot()
    await ws_manager.broadcast("visibility", "throughput", snapshot.get("warehouse_status", []))

    all_exceptions = snapshot.get("exceptions", [])
    open_p1 = [e for e in all_exceptions if e.get("priority") == "P1" and e.get("status") == "open"]

    # Always broadcast scenario_applied so every page can refetch
    await ws_manager.broadcast("exceptions", "scenario_applied", {
        "scenario_id": req.scenario_id,
        "exception_count": len([e for e in all_exceptions if e.get("status") == "open"]),
        "p1_count": len(open_p1),
    })
    # Always broadcast, including an empty list, so a cleared P1 reaches clients
    await ws_manager.broadcast("exceptions", "p1_active", open_p1)

    return ok({**result, **{k: v for k, v in meta.items() if k != "risk_plan"}})


@router.get("/scenarios")
async def list_scenarios():
    """Full scenario/risk-plan registry — used by the Simulator (name,
    affected_modules) and by Exceptions/Dashboard (risk_plan lookup by
    scenario_id)."""
    return ok(SCENARIO_META)


@router.get("/active-scenario")
async def get_active_scenario():
    """The currently applied scenario (or null) with its AI risk plan — drives
    the Executive Dashboard's AI Insights panel."""
    scenario_id = synthetic_state.get_snapshot().get("active_scenario")
    if not scenario_id:
        return ok({"scenario_id": None})
    meta = SCENARIO_META.get(scenario_id, {})
    return ok({
        "scenario_id": scenario_id,
        "name": meta.get("name", scenario_id),
        "affected_modules": meta.get("affected_modules", []),
        "risk_plan": meta.get("risk_plan"),
    })


@router.post("/regenerate-seed")
async def regenerate_seed():
    """
    Force-rebuild the synthetic baseline snapshot from scratch and persist it to disk.
    Use this to refresh demo data without restarting the server.
    WARNING: resets any active scenario and all in-flight mutations.
    """
    result = synthetic_state.force_regenerate()
    return ok({**result, "message": "Baseline snapshot regenerated and saved to disk."})
