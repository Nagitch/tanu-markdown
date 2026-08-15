// Audit recipe margins and aggregate loot-table probabilities in one read-only view.
let output = [];

for recipe in inputs.recipes {
    let material_cost = 0;
    for line in inputs.material_lines {
        if line.recipe_id == recipe.recipe_id {
            material_cost += line.material_cost;
        }
    }

    let batch_cost = material_cost + recipe.crafting_fee;
    let batch_revenue = recipe.result_sell_price * recipe.result_quantity;
    let margin = batch_revenue - batch_cost;
    let status = if margin > 0 { "profitable" } else { "review price" };

    output.push(#{
        section: "crafting",
        entry: recipe.result_name,
        cost_or_expected_value: batch_cost,
        revenue_or_probability_pct: batch_revenue,
        margin_or_probability_gap: margin,
        status: status
    });
}

let summaries = [];
for entry in inputs.loot_entries {
    let found = -1;
    for index in 0..summaries.len() {
        if summaries[index].key == entry.loot_table {
            found = index;
        }
    }

    if found < 0 {
        summaries.push(#{
            key: entry.loot_table,
            probability: entry.probability,
            expected_value: entry.expected_value
        });
    } else {
        let summary = summaries[found];
        summary.probability += entry.probability;
        summary.expected_value += entry.expected_value;
        summaries[found] = summary;
    }
}

for summary in summaries {
    let raw_difference = summary.probability * 100.0 - 100.0;
    let probability_percent = (summary.probability * 1000.0).round() / 10.0;
    let probability_ok = raw_difference > -0.001 && raw_difference < 0.001;
    let difference = if probability_ok {
        0.0
    } else {
        (raw_difference * 10.0).round() / 10.0
    };
    let status = if probability_ok {
        "probability OK"
    } else {
        "probability mismatch"
    };

    output.push(#{
        section: "loot",
        entry: summary.key,
        cost_or_expected_value: summary.expected_value,
        revenue_or_probability_pct: probability_percent,
        margin_or_probability_gap: difference,
        status: status
    });
}

output
