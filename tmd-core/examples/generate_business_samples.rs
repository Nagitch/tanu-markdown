use serde_json::{json, Map, Value};
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use tmd_core::{
    evaluate_data_source, validate_document, write_to_path, DataSourceRegistry, TmdDoc,
    DATA_SOURCES_EXTRAS_KEY,
};

const PROJECT_SCRIPT_PATH: &str = "views/business-project-profitability.rhai";
const INVENTORY_SCRIPT_PATH: &str = "views/business-inventory-replenishment.rhai";

fn column(id: &str, name: &str, constraint: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "constraint": constraint
    })
}

fn identity_column(id: &str, name: &str) -> Value {
    let mut value = column(id, name, "text");
    value["identity"] = json!(true);
    value
}

fn text(value: &str) -> Value {
    json!({
        "content": {
            "kind": "literal",
            "value": { "type": "string", "value": value }
        }
    })
}

fn integer(value: i64) -> Value {
    json!({
        "content": {
            "kind": "literal",
            "value": { "type": "integer", "value": value.to_string() }
        }
    })
}

fn real(value: f64) -> Value {
    json!({
        "content": {
            "kind": "literal",
            "value": { "type": "real", "value": value }
        }
    })
}

fn boolean(value: bool) -> Value {
    json!({
        "content": {
            "kind": "literal",
            "value": { "type": "boolean", "value": value }
        }
    })
}

fn formula(expression: impl Into<String>) -> Value {
    json!({
        "content": {
            "kind": "formula",
            "expression": expression.into()
        }
    })
}

fn direct_ref(source: &str, identity: &str, target_column: &str) -> Value {
    formula(format!(
        "REF({}, {}, {})",
        serde_json::to_string(source).expect("source string"),
        serde_json::to_string(identity).expect("identity string"),
        serde_json::to_string(target_column).expect("column string")
    ))
}

fn row(id: &str, cells: Vec<Value>) -> Value {
    json!({ "id": id, "cells": cells })
}

fn reference_group(id: &str, source: &str, rows: &[&str], columns: &[(&str, &str)]) -> Value {
    json!({
        "id": id,
        "source": source,
        "rows": rows,
        "columns": columns
            .iter()
            .map(|(column_id, target_column_id)| json!({
                "column_id": column_id,
                "target_column_id": target_column_id
            }))
            .collect::<Vec<_>>()
    })
}

fn managed_table(columns: Vec<Value>, rows: Vec<Value>) -> Value {
    json!({
        "type": "formula",
        "columns": columns,
        "rows": rows
    })
}

fn managed_table_with_references(
    columns: Vec<Value>,
    rows: Vec<Value>,
    reference_groups: Vec<Value>,
) -> Value {
    json!({
        "type": "formula",
        "columns": columns,
        "rows": rows,
        "reference_groups": reference_groups
    })
}

fn table_view(source: &str) -> String {
    format!("```tmd-view:table\nsource = \"{source}\"\n```\n")
}

fn add_sources(doc: &mut TmdDoc, sources: Map<String, Value>) {
    doc.manifest.extras = json!({
        DATA_SOURCES_EXTRAS_KEY: {
            "schema_version": 8,
            "sources": sources
        }
    });
}

fn project_profitability_document() -> Result<TmdDoc, Box<dyn Error>> {
    let mut markdown = String::from(
        "# Project profitability workbook\n\n\
         Use this workbook to test whether consulting projects are earning enough margin. The editable masters keep commercial assumptions in one place, the detail tables capture hours and expenses, and the final Rhai view combines all three inputs into a read-only portfolio report.\n\n\
         ## Try it\n\n\
         1. Raise the Software Engineer billing rate in **Rate card** and watch every matching worklog row and project margin update.\n\
         2. In **Worklog**, use the referenced-row picker to change an entry's project or role; the locked reference cells move together.\n\
         3. Toggle a worklog entry's `billable` value or an expense's `charge_customer` value to expose hidden delivery cost.\n\
         4. Add a project, worklog entry, or expense, then refresh the report to include it. New detail rows should select identities from the appropriate master.\n\n\
         The four source tables below are managed Formula tables and are editable. **Portfolio profitability** is produced by Rhai and is intentionally read-only.\n\n\
         ## Project master\n\n",
    );
    markdown.push_str(&table_view("projects"));
    markdown.push_str("\n## Rate card\n\n");
    markdown.push_str(&table_view("rate-card"));
    markdown.push_str("\n## Worklog\n\n");
    markdown.push_str(&table_view("worklog"));
    markdown.push_str("\n## Project expenses\n\n");
    markdown.push_str(&table_view("expenses"));
    markdown.push_str(
        "\n## Portfolio profitability (read-only)\n\nThe report adds billable labor and customer-charged expenses to revenue, while all labor and expenses remain costs. `budget_remaining` compares the cost budget with actual cost.\n\n",
    );
    markdown.push_str(&table_view("profitability-summary"));

    let mut sources = Map::new();
    sources.insert(
        "projects".to_owned(),
        managed_table(
            vec![
                identity_column("project-id", "project_id"),
                column("project-name", "project_name", "text"),
                column("customer", "customer", "text"),
                column("cost-budget", "cost_budget", "number"),
            ],
            vec![
                row(
                    "project-alpha",
                    vec![
                        text("P-ALPHA"),
                        text("Mobile Checkout Revamp"),
                        text("Northwind Retail"),
                        real(32_000.0),
                    ],
                ),
                row(
                    "project-beta",
                    vec![
                        text("P-BETA"),
                        text("Analytics Data Hub"),
                        text("Contoso Games"),
                        real(45_000.0),
                    ],
                ),
                row(
                    "project-gamma",
                    vec![
                        text("P-GAMMA"),
                        text("Support Automation Pilot"),
                        text("Adventure Works"),
                        real(18_000.0),
                    ],
                ),
            ],
        ),
    );
    sources.insert(
        "rate-card".to_owned(),
        managed_table(
            vec![
                identity_column("role-id", "role_id"),
                column("role-name", "role_name", "text"),
                column("billing-rate", "billing_rate", "number"),
                column("cost-rate", "cost_rate", "number"),
            ],
            vec![
                row(
                    "role-lead",
                    vec![
                        text("ROLE-LEAD"),
                        text("Delivery Lead"),
                        real(180.0),
                        real(110.0),
                    ],
                ),
                row(
                    "role-engineer",
                    vec![
                        text("ROLE-ENG"),
                        text("Software Engineer"),
                        real(145.0),
                        real(85.0),
                    ],
                ),
                row(
                    "role-data",
                    vec![
                        text("ROLE-DATA"),
                        text("Data Engineer"),
                        real(160.0),
                        real(95.0),
                    ],
                ),
                row(
                    "role-qa",
                    vec![
                        text("ROLE-QA"),
                        text("QA Engineer"),
                        real(110.0),
                        real(65.0),
                    ],
                ),
            ],
        ),
    );

    let worklog_seed = [
        (
            "work-1",
            "W-001",
            "P-ALPHA",
            "Aiko",
            "ROLE-LEAD",
            32.0,
            true,
        ),
        ("work-2", "W-002", "P-ALPHA", "Ben", "ROLE-ENG", 120.0, true),
        ("work-3", "W-003", "P-ALPHA", "Chika", "ROLE-QA", 48.0, true),
        ("work-4", "W-004", "P-BETA", "Aiko", "ROLE-LEAD", 28.0, true),
        (
            "work-5",
            "W-005",
            "P-BETA",
            "Diego",
            "ROLE-DATA",
            160.0,
            true,
        ),
        ("work-6", "W-006", "P-BETA", "Ben", "ROLE-ENG", 64.0, false),
        (
            "work-7",
            "W-007",
            "P-GAMMA",
            "Aiko",
            "ROLE-LEAD",
            20.0,
            true,
        ),
        ("work-8", "W-008", "P-GAMMA", "Ben", "ROLE-ENG", 72.0, true),
    ];
    let worklog_rows = worklog_seed
        .iter()
        .enumerate()
        .map(
            |(index, (row_id, entry_id, project_id, consultant, role_id, hours, billable))| {
                let row_number = index + 1;
                row(
                    row_id,
                    vec![
                        text(entry_id),
                        direct_ref("projects", project_id, "project_id"),
                        direct_ref("projects", project_id, "project_name"),
                        text(consultant),
                        direct_ref("rate-card", role_id, "role_id"),
                        direct_ref("rate-card", role_id, "role_name"),
                        direct_ref("rate-card", role_id, "billing_rate"),
                        direct_ref("rate-card", role_id, "cost_rate"),
                        real(*hours),
                        boolean(*billable),
                        formula(format!(
                            "IF(J{row_number}, I{row_number} * G{row_number}, 0.0)"
                        )),
                        formula(format!("I{row_number} * H{row_number}")),
                        formula(format!("K{row_number} - L{row_number}")),
                        formula(format!(
                        "IF(K{row_number} = 0, 0.0, ROUND(M{row_number} / K{row_number} * 100, 1))"
                    )),
                    ],
                )
            },
        )
        .collect::<Vec<_>>();
    let worklog_row_ids = worklog_seed
        .iter()
        .map(|(row_id, ..)| *row_id)
        .collect::<Vec<_>>();
    sources.insert(
        "worklog".to_owned(),
        managed_table_with_references(
            vec![
                identity_column("entry-id", "entry_id"),
                column("project-id", "project_id", "text"),
                column("project-name", "project_name", "text"),
                column("consultant", "consultant", "text"),
                column("role-id", "role_id", "text"),
                column("role-name", "role_name", "text"),
                column("billing-rate", "billing_rate", "number"),
                column("cost-rate", "cost_rate", "number"),
                column("hours", "hours", "number"),
                column("billable", "billable", "boolean"),
                column("revenue", "revenue", "number"),
                column("labor-cost", "labor_cost", "number"),
                column("gross-profit", "gross_profit", "number"),
                column("margin-percent", "margin_percent", "number"),
            ],
            worklog_rows,
            vec![
                reference_group(
                    "worklog-project",
                    "projects",
                    &worklog_row_ids,
                    &[
                        ("project-id", "project-id"),
                        ("project-name", "project-name"),
                    ],
                ),
                reference_group(
                    "worklog-role",
                    "rate-card",
                    &worklog_row_ids,
                    &[
                        ("role-id", "role-id"),
                        ("role-name", "role-name"),
                        ("billing-rate", "billing-rate"),
                        ("cost-rate", "cost-rate"),
                    ],
                ),
            ],
        ),
    );

    let expense_seed = [
        (
            "expense-1",
            "X-001",
            "P-ALPHA",
            "Cloud testing",
            2_400.0,
            true,
            "Device lab",
        ),
        (
            "expense-2",
            "X-002",
            "P-ALPHA",
            "Travel",
            1_100.0,
            false,
            "Workshop travel",
        ),
        (
            "expense-3",
            "X-003",
            "P-BETA",
            "Warehouse usage",
            3_600.0,
            true,
            "Load testing",
        ),
        (
            "expense-4",
            "X-004",
            "P-BETA",
            "Software licenses",
            2_200.0,
            false,
            "Internal tooling",
        ),
        (
            "expense-5",
            "X-005",
            "P-GAMMA",
            "Vendor API",
            900.0,
            true,
            "Pilot quota",
        ),
    ];
    let expense_rows = expense_seed
        .iter()
        .enumerate()
        .map(
            |(index, (row_id, expense_id, project_id, category, amount, charge, note))| {
                let row_number = index + 1;
                row(
                    row_id,
                    vec![
                        text(expense_id),
                        direct_ref("projects", project_id, "project_id"),
                        direct_ref("projects", project_id, "project_name"),
                        text(category),
                        real(*amount),
                        boolean(*charge),
                        formula(format!("IF(F{row_number}, E{row_number}, 0.0)")),
                        text(note),
                    ],
                )
            },
        )
        .collect::<Vec<_>>();
    let expense_row_ids = expense_seed
        .iter()
        .map(|(row_id, ..)| *row_id)
        .collect::<Vec<_>>();
    sources.insert(
        "expenses".to_owned(),
        managed_table_with_references(
            vec![
                identity_column("expense-id", "expense_id"),
                column("project-id", "project_id", "text"),
                column("project-name", "project_name", "text"),
                column("category", "category", "text"),
                column("amount", "amount", "number"),
                column("charge-customer", "charge_customer", "boolean"),
                column("customer-charge", "customer_charge", "number"),
                column("note", "note", "text"),
            ],
            expense_rows,
            vec![reference_group(
                "expense-project",
                "projects",
                &expense_row_ids,
                &[
                    ("project-id", "project-id"),
                    ("project-name", "project-name"),
                ],
            )],
        ),
    );
    sources.insert(
        "profitability-summary".to_owned(),
        json!({
            "type": "rhai",
            "script": PROJECT_SCRIPT_PATH,
            "inputs": {
                "projects": "projects",
                "worklog": "worklog",
                "expenses": "expenses"
            },
            "output": {
                "type": "table",
                "columns": [
                    "project_id",
                    "project_name",
                    "logged_hours",
                    "total_revenue",
                    "labor_cost",
                    "expense_cost",
                    "gross_profit",
                    "margin_percent",
                    "cost_budget",
                    "budget_remaining"
                ]
            }
        }),
    );

    let mut doc = TmdDoc::new(markdown)?;
    doc.manifest.title = Some("Project profitability workbook".to_owned());
    doc.manifest.authors = vec!["Tanu Markdown contributors".to_owned()];
    doc.manifest.tags = vec![
        "sample".to_owned(),
        "business".to_owned(),
        "formula".to_owned(),
        "rhai".to_owned(),
        "profitability".to_owned(),
    ];
    add_sources(&mut doc, sources);
    doc.add_attachment(
        PROJECT_SCRIPT_PATH,
        "text/x-rhai".parse()?,
        include_bytes!("../../tmd-sample/views/business-project-profitability.rhai").to_vec(),
    )?;
    Ok(doc)
}

fn inventory_replenishment_document() -> Result<TmdDoc, Box<dyn Error>> {
    let mut markdown = String::from(
        "# Inventory replenishment planner\n\n\
         Use this workbook to turn stock positions into case-pack-aware purchase quantities. Product policy lives in one editable master, warehouse counts live in an editable planning table, and a read-only Rhai report groups the resulting purchase plan by supplier.\n\n\
         ## Try it\n\n\
         1. Change a product's `target_stock`, `reorder_point`, or `case_pack` and watch the order quantity recalculate.\n\
         2. Edit `on_hand`, `reserved`, or `incoming` to simulate the next stock snapshot.\n\
         3. Use the referenced-row picker in **Inventory plan** to replace a product; SKU, name, supplier, price, and replenishment policy stay aligned.\n\
         4. Set an item below its reorder point and confirm that `CEILING(shortage / case_pack)` rounds the purchase up to a full case.\n\n\
         **Product master** and **Inventory plan** are managed Formula tables and are editable. **Supplier purchase summary** is produced from both inputs by Rhai and is intentionally read-only.\n\n\
         ## Product master\n\n",
    );
    markdown.push_str(&table_view("products"));
    markdown.push_str("\n## Inventory plan\n\n");
    markdown.push_str(&table_view("inventory-plan"));
    markdown.push_str(
        "\n## Supplier purchase summary (read-only)\n\n`order_value` is the estimated purchase cost after rounding every required order to its case pack.\n\n",
    );
    markdown.push_str(&table_view("supplier-purchase-summary"));

    let product_seed = [
        (
            "product-potion",
            "SKU-POTION",
            "Health Potion",
            "Alchemy House",
            12.5,
            30,
            80,
            12,
        ),
        (
            "product-ether",
            "SKU-ETHER",
            "Ether Flask",
            "Alchemy House",
            18.0,
            30,
            80,
            12,
        ),
        (
            "product-iron",
            "SKU-IRON",
            "Iron Ore",
            "Forge Cooperative",
            4.25,
            100,
            250,
            50,
        ),
        (
            "product-oak",
            "SKU-OAK",
            "Oak Timber",
            "Forge Cooperative",
            6.75,
            150,
            300,
            25,
        ),
        (
            "product-crystal",
            "SKU-CRYSTAL",
            "Mystic Crystal",
            "Arcane Imports",
            42.0,
            10,
            30,
            5,
        ),
    ];
    let product_rows = product_seed
        .iter()
        .map(
            |(row_id, sku, name, supplier, unit_cost, reorder_point, target_stock, case_pack)| {
                row(
                    row_id,
                    vec![
                        text(sku),
                        text(name),
                        text(supplier),
                        real(*unit_cost),
                        integer(*reorder_point),
                        integer(*target_stock),
                        integer(*case_pack),
                    ],
                )
            },
        )
        .collect::<Vec<_>>();

    let mut sources = Map::new();
    sources.insert(
        "products".to_owned(),
        managed_table(
            vec![
                identity_column("sku", "sku"),
                column("product-name", "product_name", "text"),
                column("supplier", "supplier", "text"),
                column("unit-cost", "unit_cost", "number"),
                column("reorder-point", "reorder_point", "number"),
                column("target-stock", "target_stock", "number"),
                column("case-pack", "case_pack", "number"),
            ],
            product_rows,
        ),
    );

    let inventory_seed = [
        ("inventory-potion", "SKU-POTION", 24, 10, 0),
        ("inventory-ether", "SKU-ETHER", 45, 8, 24),
        ("inventory-iron", "SKU-IRON", 105, 20, 0),
        ("inventory-oak", "SKU-OAK", 220, 15, 25),
        ("inventory-crystal", "SKU-CRYSTAL", 7, 2, 0),
    ];
    let inventory_rows = inventory_seed
        .iter()
        .enumerate()
        .map(|(index, (row_id, sku, on_hand, reserved, incoming))| {
            let row_number = index + 1;
            row(
                row_id,
                vec![
                    direct_ref("products", sku, "sku"),
                    direct_ref("products", sku, "product_name"),
                    direct_ref("products", sku, "supplier"),
                    direct_ref("products", sku, "unit_cost"),
                    direct_ref("products", sku, "reorder_point"),
                    direct_ref("products", sku, "target_stock"),
                    direct_ref("products", sku, "case_pack"),
                    integer(*on_hand),
                    integer(*reserved),
                    integer(*incoming),
                    formula(format!("H{row_number} - I{row_number} + J{row_number}")),
                    formula(format!(
                        "IF(K{row_number} < E{row_number}, MAX(F{row_number} - K{row_number}, 0), 0)"
                    )),
                    formula(format!(
                        "IF(L{row_number} = 0, 0, CEILING(L{row_number} / G{row_number}))"
                    )),
                    formula(format!("M{row_number} * G{row_number}")),
                    formula(format!("ROUND(N{row_number} * D{row_number}, 2)")),
                    formula(format!(
                        "IF(N{row_number} > 0, \"REORDER\", \"OK\")"
                    )),
                ],
            )
        })
        .collect::<Vec<_>>();
    let inventory_row_ids = inventory_seed
        .iter()
        .map(|(row_id, ..)| *row_id)
        .collect::<Vec<_>>();
    sources.insert(
        "inventory-plan".to_owned(),
        managed_table_with_references(
            vec![
                column("sku", "sku", "text"),
                column("product-name", "product_name", "text"),
                column("supplier", "supplier", "text"),
                column("unit-cost", "unit_cost", "number"),
                column("reorder-point", "reorder_point", "number"),
                column("target-stock", "target_stock", "number"),
                column("case-pack", "case_pack", "number"),
                column("on-hand", "on_hand", "number"),
                column("reserved", "reserved", "number"),
                column("incoming", "incoming", "number"),
                column("available", "available", "number"),
                column("shortage", "shortage", "number"),
                column("cases-to-order", "cases_to_order", "number"),
                column("order-quantity", "order_quantity", "number"),
                column("order-amount", "order_amount", "number"),
                column("status", "status", "text"),
            ],
            inventory_rows,
            vec![reference_group(
                "inventory-product",
                "products",
                &inventory_row_ids,
                &[
                    ("sku", "sku"),
                    ("product-name", "product-name"),
                    ("supplier", "supplier"),
                    ("unit-cost", "unit-cost"),
                    ("reorder-point", "reorder-point"),
                    ("target-stock", "target-stock"),
                    ("case-pack", "case-pack"),
                ],
            )],
        ),
    );
    sources.insert(
        "supplier-purchase-summary".to_owned(),
        json!({
            "type": "rhai",
            "script": INVENTORY_SCRIPT_PATH,
            "inputs": {
                "products": "products",
                "inventory": "inventory-plan"
            },
            "output": {
                "type": "table",
                "columns": [
                    "supplier",
                    "sku_count",
                    "below_reorder_count",
                    "units_to_order",
                    "order_value"
                ]
            }
        }),
    );

    let mut doc = TmdDoc::new(markdown)?;
    doc.manifest.title = Some("Inventory replenishment planner".to_owned());
    doc.manifest.authors = vec!["Tanu Markdown contributors".to_owned()];
    doc.manifest.tags = vec![
        "sample".to_owned(),
        "business".to_owned(),
        "formula".to_owned(),
        "rhai".to_owned(),
        "inventory".to_owned(),
    ];
    add_sources(&mut doc, sources);
    doc.add_attachment(
        INVENTORY_SCRIPT_PATH,
        "text/x-rhai".parse()?,
        include_bytes!("../../tmd-sample/views/business-inventory-replenishment.rhai").to_vec(),
    )?;
    Ok(doc)
}

fn validate_and_write(doc: &TmdDoc, output: &Path) -> Result<(), Box<dyn Error>> {
    let registry = DataSourceRegistry::from_manifest_extras(&doc.manifest.extras)?;
    for source_name in registry.sources.keys() {
        evaluate_data_source(doc, source_name)?;
    }

    let report = validate_document(doc)?;
    if !report.valid {
        let details = report
            .issues
            .iter()
            .map(|issue| format!("{}: {}", issue.code, issue.message))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(io::Error::other(format!(
            "document validation failed for {}:\n{details}",
            output.display()
        ))
        .into());
    }

    write_to_path(output, doc)?;
    println!("generated {}", output.display());
    Ok(())
}

fn sample_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tmd-sample")
}

fn main() -> Result<(), Box<dyn Error>> {
    let sample_directory = sample_directory();
    validate_and_write(
        &project_profitability_document()?,
        &sample_directory.join("project-profitability.tmd"),
    )?;
    validate_and_write(
        &inventory_replenishment_document()?,
        &sample_directory.join("inventory-replenishment.tmd"),
    )?;
    Ok(())
}
