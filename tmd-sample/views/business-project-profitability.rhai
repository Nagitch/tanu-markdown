// Read-only project rollup over three editable managed Formula tables.
let output = [];

for project in inputs.projects {
    let labor_revenue = 0.0;
    let labor_cost = 0.0;
    let logged_hours = 0.0;

    for entry in inputs.worklog {
        if entry.project_id == project.project_id {
            labor_revenue += entry.revenue;
            labor_cost += entry.labor_cost;
            logged_hours += entry.hours;
        }
    }

    let expense_cost = 0.0;
    let expense_charge = 0.0;
    for expense in inputs.expenses {
        if expense.project_id == project.project_id {
            expense_cost += expense.amount;
            expense_charge += expense.customer_charge;
        }
    }

    let total_revenue = labor_revenue + expense_charge;
    let total_cost = labor_cost + expense_cost;
    let gross_profit = total_revenue - total_cost;
    let margin_percent = if total_revenue == 0.0 {
        0.0
    } else {
        (gross_profit / total_revenue * 1000.0).round() / 10.0
    };

    output.push(#{
        project_id: project.project_id,
        project_name: project.project_name,
        logged_hours: logged_hours,
        total_revenue: total_revenue,
        labor_cost: labor_cost,
        expense_cost: expense_cost,
        gross_profit: gross_profit,
        margin_percent: margin_percent,
        cost_budget: project.cost_budget,
        budget_remaining: project.cost_budget - total_cost
    });
}

output
