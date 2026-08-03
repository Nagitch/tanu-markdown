// `inputs.sales` is the table returned by the named SQLite source `sales`.
// Each input row is a map whose keys are the SQLite result-column names.
let totals = #{};

for row in inputs.sales {
    if row.category in totals {
        totals[row.category] += row.amount_cents;
    } else {
        totals[row.category] = row.amount_cents;
    }
}

// A table source returns an array of maps. Every map must contain exactly the
// columns declared by the source's `output.columns`, in this case
// `category`, `order_count`, and `total_cents`.
let categories = totals.keys();
categories.sort();

let output = [];
for category in categories {
    let order_count = 0;
    for row in inputs.sales {
        if row.category == category {
            order_count += 1;
        }
    }

    output.push(#{
        category: category,
        order_count: order_count,
        total_cents: totals[category]
    });
}

output
