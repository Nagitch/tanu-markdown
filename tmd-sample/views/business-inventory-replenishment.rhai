// Read-only purchase rollup over the editable product and inventory tables.
let sku_counts = #{};
let units_to_order = #{};
let order_values = #{};
let below_reorder_counts = #{};

for product in inputs.products {
    let supplier = product.supplier;
    if supplier in sku_counts {
        sku_counts[supplier] += 1;
    } else {
        sku_counts[supplier] = 1;
        units_to_order[supplier] = 0.0;
        order_values[supplier] = 0.0;
        below_reorder_counts[supplier] = 0;
    }
}

for row in inputs.inventory {
    let supplier = row.supplier;
    if supplier in units_to_order {
        units_to_order[supplier] += row.order_quantity;
        order_values[supplier] += row.order_amount;
        if row.status == "REORDER" {
            below_reorder_counts[supplier] += 1;
        }
    } else {
        // Keep the report useful if an inventory row temporarily refers to a
        // supplier that is not represented in the current product input.
        sku_counts[supplier] = 0;
        units_to_order[supplier] = row.order_quantity;
        order_values[supplier] = row.order_amount;
        below_reorder_counts[supplier] = if row.status == "REORDER" { 1 } else { 0 };
    }
}

let suppliers = sku_counts.keys();
suppliers.sort();

let output = [];
for supplier in suppliers {
    output.push(#{
        supplier: supplier,
        sku_count: sku_counts[supplier],
        below_reorder_count: below_reorder_counts[supplier],
        units_to_order: units_to_order[supplier],
        order_value: order_values[supplier]
    });
}

output
