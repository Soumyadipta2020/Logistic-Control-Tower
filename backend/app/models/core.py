import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    String, Text, Boolean, Integer, Numeric, Date, DateTime,
    ForeignKey, UniqueConstraint, Index, Computed,
)
from sqlalchemy import String, Integer, Float, Boolean, ForeignKey, DateTime, Date, Enum, Numeric, JSON, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base


def now_utc():
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────
# PARTS & SUPPLIERS
# ─────────────────────────────────────────────

class PartsCatalog(Base):
    __tablename__ = "parts_catalog"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sku_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    sub_category: Mapped[str | None] = mapped_column(String(80))
    brand: Mapped[str | None] = mapped_column(String(100))
    weight_kg: Mapped[float | None] = mapped_column(Numeric(8, 3))
    dimensions_cm: Mapped[dict | None] = mapped_column(JSON)
    is_high_velocity: Mapped[bool] = mapped_column(Boolean, default=False)
    requires_hgv: Mapped[bool] = mapped_column(Boolean, default=False)
    locker_eligible: Mapped[bool] = mapped_column(Boolean, default=True)
    unit_cost_gbp: Mapped[float | None] = mapped_column(Numeric(10, 2))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)

    __table_args__ = (
        Index("idx_parts_category", "category"),
        Index("idx_parts_sku", "sku_code"),
    )


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    country_code: Mapped[str | None] = mapped_column(String(2))
    ariba_id: Mapped[str | None] = mapped_column(String(100))
    sedex_id: Mapped[str | None] = mapped_column(String(100))
    is_tier1: Mapped[bool] = mapped_column(Boolean, default=False)
    is_sme: Mapped[bool] = mapped_column(Boolean, default=False)
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=60)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    scorecards: Mapped[list["SupplierScorecard"]] = relationship(back_populates="supplier")


class SupplierScorecard(Base):
    __tablename__ = "supplier_scorecards"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    supplier_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("suppliers.id", ondelete="CASCADE"))
    week_start: Mapped[datetime] = mapped_column(Date, nullable=False)
    orders_placed: Mapped[int | None] = mapped_column(Integer)
    orders_on_time: Mapped[int | None] = mapped_column(Integer)
    orders_in_full: Mapped[int | None] = mapped_column(Integer)
    otif_score: Mapped[float | None] = mapped_column(Numeric(5, 2))
    ariba_compliance_status: Mapped[str | None] = mapped_column(String(20))
    sedex_risk_level: Mapped[str | None] = mapped_column(String(20))
    financial_health_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    geopolitical_risk_flag: Mapped[bool] = mapped_column(Boolean, default=False)
    composite_risk_score: Mapped[int | None] = mapped_column(Integer)
    review_triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    supplier: Mapped["Supplier"] = relationship(back_populates="scorecards")

    __table_args__ = (
        UniqueConstraint("supplier_id", "week_start"),
        Index("idx_scorecards_supplier", "supplier_id"),
        Index("idx_scorecards_week", "week_start"),
    )


# ─────────────────────────────────────────────
# WAREHOUSES & LOCKERS
# ─────────────────────────────────────────────

class Warehouse(Base):
    __tablename__ = "warehouses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(30), nullable=False)
    operator: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[dict | None] = mapped_column(JSON)
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    baseline_items_per_hour: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    throughputs: Mapped[list["WarehouseThroughput"]] = relationship(back_populates="warehouse")
    inventory: Mapped[list["WarehouseInventory"]] = relationship(back_populates="warehouse")


class WarehouseInventory(Base):
    __tablename__ = "warehouse_inventory"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"))
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    quantity_on_hand: Mapped[int] = mapped_column(Integer, default=0)
    quantity_reserved: Mapped[int] = mapped_column(Integer, default=0)
    safety_stock_level: Mapped[int | None] = mapped_column(Integer)
    reorder_point: Mapped[int | None] = mapped_column(Integer)
    days_of_supply: Mapped[float | None] = mapped_column(Numeric(6, 1))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)

    warehouse: Mapped["Warehouse"] = relationship(back_populates="inventory")

    __table_args__ = (
        UniqueConstraint("warehouse_id", "sku_id"),
        Index("idx_wh_inv_warehouse", "warehouse_id"),
        Index("idx_wh_inv_sku", "sku_id"),
    )


class LockerSite(Base):
    __tablename__ = "locker_sites"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    bybox_site_code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str | None] = mapped_column(String(200))
    address: Mapped[dict | None] = mapped_column(JSON)
    postcode: Mapped[str | None] = mapped_column(String(10))
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    total_slots: Mapped[int] = mapped_column(Integer, default=50)
    region: Mapped[str | None] = mapped_column(String(100))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_delivery_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    inventory: Mapped[list["LockerInventory"]] = relationship(back_populates="locker_site")

    __table_args__ = (
        Index("idx_locker_postcode", "postcode"),
        Index("idx_locker_region", "region"),
    )


class LockerInventory(Base):
    __tablename__ = "locker_inventory"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    locker_site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("locker_sites.id"))
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    reserved_for_engineer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    pre_8am_delivered: Mapped[bool] = mapped_column(Boolean, default=False)
    pre_8am_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fill_pct: Mapped[float | None] = mapped_column(Numeric(5, 2))
    last_restocked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)

    locker_site: Mapped["LockerSite"] = relationship(back_populates="inventory")

    __table_args__ = (UniqueConstraint("locker_site_id", "sku_id"),)


# ─────────────────────────────────────────────
# ENGINEERS
# ─────────────────────────────────────────────

class Engineer(Base):
    __tablename__ = "engineers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    engineer_code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    business_unit: Mapped[str] = mapped_column(String(50), nullable=False)
    region: Mapped[str | None] = mapped_column(String(100))
    home_postcode: Mapped[str | None] = mapped_column(String(10))
    van_registration: Mapped[str | None] = mapped_column(String(20))
    acs_certifications: Mapped[list | None] = mapped_column(JSON)
    smet2_certified: Mapped[bool] = mapped_column(Boolean, default=False)
    heat_pump_certified: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    academy_trained: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    locations: Mapped[list["EngineerLocation"]] = relationship(back_populates="engineer")
    van_stock: Mapped[list["VanStock"]] = relationship(back_populates="engineer")
    jobs: Mapped[list["Job"]] = relationship(back_populates="engineer")

    __table_args__ = (
        Index("idx_engineer_bu", "business_unit"),
        Index("idx_engineer_region", "region"),
    )


class EngineerLocation(Base):
    __tablename__ = "engineer_locations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    engineer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("engineers.id"))
    latitude: Mapped[float] = mapped_column(Numeric(9, 6), nullable=False)
    longitude: Mapped[float] = mapped_column(Numeric(9, 6), nullable=False)
    accuracy_m: Mapped[int | None] = mapped_column(Integer)
    job_status: Mapped[str | None] = mapped_column(String(20))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    engineer: Mapped["Engineer"] = relationship(back_populates="locations")

    __table_args__ = (Index("idx_eng_loc_engineer", "engineer_id", "recorded_at"),)


class VanStock(Base):
    __tablename__ = "van_stock"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    engineer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("engineers.id"))
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    min_quantity: Mapped[int] = mapped_column(Integer, default=0)
    standard_quantity: Mapped[int | None] = mapped_column(Integer)
    last_replenishment_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)

    engineer: Mapped["Engineer"] = relationship(back_populates="van_stock")

    __table_args__ = (
        UniqueConstraint("engineer_id", "sku_id"),
        Index("idx_van_stock_engineer", "engineer_id"),
    )


# ─────────────────────────────────────────────
# JOBS
# ─────────────────────────────────────────────

class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    engineer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("engineers.id"))
    customer_ref: Mapped[str | None] = mapped_column(String(50))
    property_postcode: Mapped[str | None] = mapped_column(String(10))
    property_type: Mapped[str | None] = mapped_column(String(30))
    job_type: Mapped[str] = mapped_column(String(50), nullable=False)
    boiler_brand: Mapped[str | None] = mapped_column(String(100))
    boiler_model: Mapped[str | None] = mapped_column(String(100))
    scheduled_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
    parts_status: Mapped[str] = mapped_column(String(20), default="pending")
    first_time_fix: Mapped[bool | None] = mapped_column(Boolean)
    requires_hgv: Mapped[bool] = mapped_column(Boolean, default=False)
    decommission_required: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    engineer: Mapped["Engineer | None"] = relationship(back_populates="jobs")
    parts: Mapped[list["JobPart"]] = relationship(back_populates="job")

    __table_args__ = (
        Index("idx_jobs_engineer", "engineer_id"),
        Index("idx_jobs_status", "status"),
        Index("idx_jobs_scheduled", "scheduled_start"),
    )


class JobPart(Base):
    __tablename__ = "job_parts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id"))
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    quantity_required: Mapped[int] = mapped_column(Integer, nullable=False)
    delivery_mode: Mapped[str | None] = mapped_column(String(20))
    locker_site_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("locker_sites.id"))
    source_warehouse_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    job: Mapped["Job"] = relationship(back_populates="parts")

    __table_args__ = (UniqueConstraint("job_id", "sku_id"),)


# ─────────────────────────────────────────────
# INBOUND & PURCHASE ORDERS
# ─────────────────────────────────────────────

class InboundShipment(Base):
    __tablename__ = "inbound_shipments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shipment_ref: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    supplier_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("suppliers.id"))
    destination_warehouse_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"))
    carrier: Mapped[str | None] = mapped_column(String(100))
    origin_country: Mapped[str | None] = mapped_column(String(2))
    port_of_entry: Mapped[str | None] = mapped_column(String(100))
    scheduled_arrival: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    predicted_arrival: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actual_arrival: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delay_hours: Mapped[float | None] = mapped_column(Numeric(6, 2))
    status: Mapped[str] = mapped_column(String(20), default="in_transit")
    carrier_tracking_ref: Mapped[str | None] = mapped_column(String(100))
    alert_raised: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    __table_args__ = (
        Index("idx_shipments_status", "status"),
        Index("idx_shipments_arrival", "predicted_arrival"),
    )


class InboundShipmentItem(Base):
    __tablename__ = "inbound_shipment_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    shipment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("inbound_shipments.id"))
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    po_number: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    supplier_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("suppliers.id"))
    warehouse_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"))
    po_type: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    total_value_gbp: Mapped[float | None] = mapped_column(Numeric(12, 2))
    is_auto_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    triggered_by_rule: Mapped[str | None] = mapped_column(String(100))
    ariba_checked: Mapped[bool] = mapped_column(Boolean, default=False)
    ordered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expected_delivery: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    items: Mapped[list["PurchaseOrderItem"]] = relationship(back_populates="po")

    __table_args__ = (
        Index("idx_po_status", "status"),
        Index("idx_po_supplier", "supplier_id"),
    )


class PurchaseOrderItem(Base):
    __tablename__ = "purchase_order_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    po_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("purchase_orders.id"))
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    quantity_ordered: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity_received: Mapped[int] = mapped_column(Integer, default=0)
    unit_price_gbp: Mapped[float | None] = mapped_column(Numeric(10, 2))

    po: Mapped["PurchaseOrder"] = relationship(back_populates="items")


# ─────────────────────────────────────────────
# DEMAND & IOT
# ─────────────────────────────────────────────

class DemandForecast(Base):
    __tablename__ = "demand_forecasts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sku_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    forecast_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    horizon_days: Mapped[int] = mapped_column(Integer, nullable=False)
    region: Mapped[str | None] = mapped_column(String(100))
    business_unit: Mapped[str | None] = mapped_column(String(50))
    forecasted_qty: Mapped[int | None] = mapped_column(Integer)
    confidence_lower_qty: Mapped[int | None] = mapped_column(Integer)
    confidence_upper_qty: Mapped[int | None] = mapped_column(Integer)
    accuracy_pct: Mapped[float | None] = mapped_column(Numeric(5, 2))
    model_version: Mapped[str | None] = mapped_column(String(20))
    signals_used: Mapped[dict | None] = mapped_column(JSON)
    weather_uplift_factor: Mapped[float | None] = mapped_column(Numeric(4, 3))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    __table_args__ = (
        Index("idx_forecast_sku", "sku_id"),
        Index("idx_forecast_date", "forecast_date"),
    )


class BoilerIQSignal(Base):
    __tablename__ = "boiler_iq_signals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id: Mapped[str] = mapped_column(String(100), nullable=False)
    property_postcode: Mapped[str | None] = mapped_column(String(10))
    boiler_brand: Mapped[str | None] = mapped_column(String(100))
    boiler_model: Mapped[str | None] = mapped_column(String(100))
    boiler_age_years: Mapped[float | None] = mapped_column(Numeric(4, 1))
    fault_type: Mapped[str | None] = mapped_column(String(100))
    fault_probability: Mapped[float | None] = mapped_column(Numeric(5, 4))
    replacement_probability_90d: Mapped[float | None] = mapped_column(Numeric(5, 4))
    pre_positioning_triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    parts_reserved: Mapped[list | None] = mapped_column(JSON)
    proactive_outreach_queued: Mapped[bool] = mapped_column(Boolean, default=False)
    signal_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("idx_boiler_device", "device_id"),
        Index("idx_boiler_postcode", "property_postcode"),
        Index("idx_boiler_timestamp", "signal_timestamp"),
    )


# ─────────────────────────────────────────────
# WAREHOUSE OPERATIONS
# ─────────────────────────────────────────────

class WarehouseThroughput(Base):
    __tablename__ = "warehouse_throughput"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    items_picked: Mapped[int | None] = mapped_column(Integer)
    items_dispatched: Mapped[int | None] = mapped_column(Integer)
    items_per_hour: Mapped[float | None] = mapped_column(Numeric(8, 2))
    throughput_vs_baseline_pct: Mapped[float | None] = mapped_column(Numeric(5, 2))
    courier_ot_rate: Mapped[float | None] = mapped_column(Numeric(5, 2))
    staff_present: Mapped[int | None] = mapped_column(Integer)
    is_disrupted: Mapped[bool] = mapped_column(Boolean, default=False)

    warehouse: Mapped["Warehouse"] = relationship(back_populates="throughputs")

    __table_args__ = (Index("idx_throughput_warehouse", "warehouse_id", "recorded_at"),)


class LabourRiskAssessment(Base):
    __tablename__ = "labour_risk_assessments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id"))
    assessment_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    risk_score: Mapped[int] = mapped_column(Integer, nullable=False)
    gmb_activity_level: Mapped[str | None] = mapped_column(String(20))
    unite_activity_level: Mapped[str | None] = mapped_column(String(20))
    news_signal_count: Mapped[int] = mapped_column(Integer, default=0)
    management_comms_normal: Mapped[bool] = mapped_column(Boolean, default=True)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    __table_args__ = (UniqueConstraint("warehouse_id", "assessment_date"),)


# ─────────────────────────────────────────────
# EXCEPTIONS & PLAYBOOKS
# ─────────────────────────────────────────────

class Exception_(Base):
    __tablename__ = "exceptions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exception_code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    priority: Mapped[str] = mapped_column(String(2), nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    impacted_engineer_count: Mapped[int] = mapped_column(Integer, default=0)
    impacted_skus: Mapped[list | None] = mapped_column(JSON)
    estimated_resolution_hours: Mapped[float | None] = mapped_column(Numeric(5, 1))
    recommended_action: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="open")
    automated_action_taken: Mapped[str | None] = mapped_column(Text)
    playbook_activated: Mapped[str | None] = mapped_column(String(1))
    alert_channels_notified: Mapped[dict | None] = mapped_column(JSON)
    acknowledged_by: Mapped[str | None] = mapped_column(String(100))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[str | None] = mapped_column(String(100))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    root_cause: Mapped[str | None] = mapped_column(Text)
    recurrence_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)

    playbook_activations: Mapped[list["PlaybookActivation"]] = relationship(back_populates="exception")

    __table_args__ = (
        Index("idx_exceptions_priority", "priority", "status"),
        Index("idx_exceptions_created", "created_at"),
    )


class PlaybookActivation(Base):
    __tablename__ = "playbook_activations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    playbook_code: Mapped[str] = mapped_column(String(1), nullable=False)
    exception_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("exceptions.id"))
    triggered_by: Mapped[str] = mapped_column(String(20), nullable=False)
    triggered_by_user: Mapped[str | None] = mapped_column(String(100))
    step_number: Mapped[int] = mapped_column(Integer, nullable=False)
    step_description: Mapped[str | None] = mapped_column(Text)
    step_status: Mapped[str] = mapped_column(String(20), default="standby")
    activated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    exception: Mapped["Exception_ | None"] = relationship(back_populates="playbook_activations")


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    priority: Mapped[str] = mapped_column(String(2), nullable=False)
    metric_source: Mapped[str | None] = mapped_column(String(50))
    condition: Mapped[dict] = mapped_column(JSON, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    notification_channels: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


# ─────────────────────────────────────────────
# SUSTAINABILITY
# ─────────────────────────────────────────────

class ReverseLogisticsItem(Base):
    __tablename__ = "reverse_logistics_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id"))
    engineer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("engineers.id"))
    sku_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("parts_catalog.id"))
    serial_number: Mapped[str | None] = mapped_column(String(100))
    boiler_brand: Mapped[str | None] = mapped_column(String(100))
    boiler_model: Mapped[str | None] = mapped_column(String(100))
    decommission_date: Mapped[datetime | None] = mapped_column(Date)
    property_postcode: Mapped[str | None] = mapped_column(String(10))
    disposal_route: Mapped[str | None] = mapped_column(String(50))
    collection_status: Mapped[str] = mapped_column(String(20), default="pending")
    collection_scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    hts_batch_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    weee_compliant: Mapped[bool] = mapped_column(Boolean, default=True)
    coshh_compliant: Mapped[bool] = mapped_column(Boolean, default=True)
    co2_saved_kg: Mapped[float | None] = mapped_column(Numeric(8, 2))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    __table_args__ = (
        Index("idx_reverse_status", "collection_status"),
        Index("idx_reverse_engineer", "engineer_id"),
    )


class HTSBatch(Base):
    __tablename__ = "hts_batches"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_ref: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    component_type: Mapped[str] = mapped_column(String(100), nullable=False)
    units_submitted: Mapped[int | None] = mapped_column(Integer)
    units_reconditioned: Mapped[int | None] = mapped_column(Integer)
    units_scrapped: Mapped[int | None] = mapped_column(Integer)
    yield_pct: Mapped[float | None] = mapped_column(Numeric(5, 2))
    bsi_kitemark_certified: Mapped[bool] = mapped_column(Boolean, default=False)
    warranty_years: Mapped[int] = mapped_column(Integer, default=2)
    status: Mapped[str] = mapped_column(String(20), default="submitted")
    intake_date: Mapped[datetime | None] = mapped_column(Date)
    expected_completion: Mapped[datetime | None] = mapped_column(Date)
    completed_date: Mapped[datetime | None] = mapped_column(Date)


class Scope3EmissionsLog(Base):
    __tablename__ = "scope3_emissions_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    log_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    emission_category: Mapped[str] = mapped_column(String(50), nullable=False)
    tco2e: Mapped[float | None] = mapped_column(Numeric(10, 4))
    shipment_count: Mapped[int | None] = mapped_column(Integer)
    distance_km: Mapped[float | None] = mapped_column(Numeric(10, 2))
    fuel_type: Mapped[str | None] = mapped_column(String(30))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


# ─────────────────────────────────────────────
# ANALYTICS & AUDIT
# ─────────────────────────────────────────────

class KPISnapshot(Base):
    __tablename__ = "kpi_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    snapshot_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    snapshot_type: Mapped[str] = mapped_column(String(20), nullable=False)
    tier: Mapped[int | None] = mapped_column(Integer)
    metric_key: Mapped[str] = mapped_column(String(100), nullable=False)
    metric_value: Mapped[float | None] = mapped_column(Numeric(14, 4))
    unit: Mapped[str | None] = mapped_column(String(20))
    target_value: Mapped[float | None] = mapped_column(Numeric(14, 4))
    rag_status: Mapped[str | None] = mapped_column(String(1))
    business_unit: Mapped[str | None] = mapped_column(String(50))
    region: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    __table_args__ = (Index("idx_kpi_date_metric", "snapshot_date", "metric_key"),)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    action_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(50))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    performed_by: Mapped[str | None] = mapped_column(String(100))
    details: Mapped[dict | None] = mapped_column(JSON)
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    __table_args__ = (
        Index("idx_audit_action", "action_type", "created_at"),
        Index("idx_audit_entity", "entity_type", "entity_id"),
    )
