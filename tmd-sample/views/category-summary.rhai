// Rhai owns the complete output table. The editor therefore renders it read-only.
let output = [];
for row in inputs.orders {
    output.push(#{
        item: row.item,
        total: row.total
    });
}
output
