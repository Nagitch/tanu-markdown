// Compare the editable battle cases without mutating their source tables.
let output = [];

for row in inputs.battle_cases {
    output.push(#{
        scenario: row.scenario,
        matchup: row.job_name + " / " + row.skill_name + " vs " + row.enemy_name,
        total_damage: row.total_damage,
        enemy_hp: row.enemy_hp,
        turns_to_defeat: row.turns_to_defeat,
        damage_per_mp: row.damage_per_mp,
        balance_note: row.balance_note
    });
}

output
