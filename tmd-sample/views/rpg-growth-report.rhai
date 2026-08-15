// Keep only useful checkpoints from the complete, editable level curve.
let output = [];

for row in inputs.level_curve {
    if row.level == 1 || row.level == 5 || row.level == 10 || row.level == 12 {
        output.push(#{
            profile: row.profile_name,
            level: row.level,
            max_hp: row.max_hp,
            attack: row.attack,
            required_exp: row.required_exp,
            cumulative_exp: row.cumulative_exp,
            power_index: row.power_index,
            growth_band: row.growth_band
        });
    }
}

output
