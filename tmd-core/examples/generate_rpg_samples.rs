use serde_json::{json, Value};
use std::error::Error;
use std::io::{Error as IoError, ErrorKind};
use std::path::{Path, PathBuf};
use tmd_core::{
    evaluate_data_source, validate_document, write_to_path, DataSourceRegistry, TmdDoc,
};

const BATTLE_REPORT_PATH: &str = "views/rpg-battle-report.rhai";
const GROWTH_REPORT_PATH: &str = "views/rpg-growth-report.rhai";
const ECONOMY_REPORT_PATH: &str = "views/rpg-economy-report.rhai";

const BATTLE_REPORT: &str = include_str!("../../tmd-sample/views/rpg-battle-report.rhai");
const GROWTH_REPORT: &str = include_str!("../../tmd-sample/views/rpg-growth-report.rhai");
const ECONOMY_REPORT: &str = include_str!("../../tmd-sample/views/rpg-economy-report.rhai");

fn column(id: &str, name: &str, constraint: &str, identity: bool) -> Value {
    let mut column = json!({
        "id": id,
        "name": name,
        "constraint": constraint
    });
    if identity {
        column["identity"] = json!(true);
    }
    column
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

fn row(id: impl Into<String>, cells: Vec<Value>) -> Value {
    json!({ "id": id.into(), "cells": cells })
}

fn formula_table(columns: Vec<Value>, rows: Vec<Value>, reference_groups: Vec<Value>) -> Value {
    let mut table = json!({
        "type": "formula",
        "columns": columns,
        "rows": rows
    });
    if !reference_groups.is_empty() {
        table["reference_groups"] = Value::Array(reference_groups);
    }
    table
}

fn reference_group(id: &str, source: &str, rows: Vec<String>, columns: &[(&str, &str)]) -> Value {
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

fn rhai_source(script: &str, inputs: &[(&str, &str)], columns: &[&str]) -> Value {
    let inputs = inputs
        .iter()
        .map(|(alias, source)| ((*alias).to_owned(), json!(source)))
        .collect::<serde_json::Map<_, _>>();
    json!({
        "type": "rhai",
        "script": script,
        "inputs": inputs,
        "output": {
            "type": "table",
            "columns": columns
        }
    })
}

fn direct_ref(source: &str, identity: &str, target: &str) -> Value {
    formula(format!("REF(\"{source}\", \"{identity}\", \"{target}\")"))
}

fn data_view(source: &str) -> String {
    format!("```tmd-view:table\nsource = \"{source}\"\n```\n")
}

fn new_document(title: &str, markdown: String, sources: Value) -> Result<TmdDoc, Box<dyn Error>> {
    let mut doc = TmdDoc::new(markdown)?;
    doc.manifest.title = Some(title.to_owned());
    doc.manifest.authors = vec!["Tanu Markdown contributors".to_owned()];
    doc.manifest.tags = vec![
        "sample".to_owned(),
        "formula".to_owned(),
        "rhai".to_owned(),
        "game-development".to_owned(),
        "rpg".to_owned(),
    ];
    doc.manifest.extras = json!({
        "tmd_data_sources": {
            "schema_version": 8,
            "sources": sources
        }
    });
    Ok(doc)
}

fn attach_script(doc: &mut TmdDoc, path: &str, script: &str) -> Result<(), Box<dyn Error>> {
    doc.add_attachment(path, "text/plain".parse()?, script.as_bytes().to_vec())?;
    Ok(())
}

fn verify_and_write(doc: &TmdDoc, path: &Path) -> Result<(), Box<dyn Error>> {
    let registry = DataSourceRegistry::from_manifest_extras(&doc.manifest.extras)?;
    for name in registry.sources.keys() {
        evaluate_data_source(doc, name).map_err(|error| {
            IoError::new(
                ErrorKind::InvalidData,
                format!("source `{name}` did not evaluate: {error}"),
            )
        })?;
    }

    let report = validate_document(doc)?;
    if !report.valid {
        return Err(IoError::new(
            ErrorKind::InvalidData,
            format!("document validation failed: {:?}", report.issues),
        )
        .into());
    }

    write_to_path(path, doc)?;
    println!("generated {}", path.display());
    Ok(())
}

fn battle_document() -> Result<TmdDoc, Box<dyn Error>> {
    let jobs = formula_table(
        vec![
            column("job-id", "job_id", "text", true),
            column("job-name", "job_name", "text", false),
            column("base-attack", "base_attack", "number", false),
            column("attack-growth", "attack_growth", "number", false),
            column("base-defense", "base_defense", "number", false),
        ],
        vec![
            row(
                "job-vanguard",
                vec![
                    text("vanguard"),
                    text("Vanguard"),
                    integer(48),
                    real(3.4),
                    integer(54),
                ],
            ),
            row(
                "job-ranger",
                vec![
                    text("ranger"),
                    text("Ranger"),
                    integer(42),
                    real(3.8),
                    integer(36),
                ],
            ),
            row(
                "job-arcanist",
                vec![
                    text("arcanist"),
                    text("Arcanist"),
                    integer(32),
                    real(4.6),
                    integer(28),
                ],
            ),
            row(
                "job-cleric",
                vec![
                    text("cleric"),
                    text("Cleric"),
                    integer(30),
                    real(2.8),
                    integer(44),
                ],
            ),
        ],
        vec![],
    );

    let skills = formula_table(
        vec![
            column("skill-id", "skill_id", "text", true),
            column("skill-name", "skill_name", "text", false),
            column("element", "element", "text", false),
            column("power", "skill_power", "number", false),
            column("hit-count", "hit_count", "number", false),
            column("mp-cost", "mp_cost", "number", false),
            column("critical", "can_critical", "boolean", false),
        ],
        vec![
            row(
                "skill-cleave",
                vec![
                    text("cleave"),
                    text("Cleave"),
                    text("physical"),
                    integer(145),
                    integer(1),
                    integer(8),
                    boolean(true),
                ],
            ),
            row(
                "skill-flame-arc",
                vec![
                    text("flame-arc"),
                    text("Flame Arc"),
                    text("fire"),
                    integer(170),
                    integer(1),
                    integer(14),
                    boolean(true),
                ],
            ),
            row(
                "skill-frost-volley",
                vec![
                    text("frost-volley"),
                    text("Frost Volley"),
                    text("ice"),
                    integer(115),
                    integer(3),
                    integer(20),
                    boolean(true),
                ],
            ),
            row(
                "skill-chain-spark",
                vec![
                    text("chain-spark"),
                    text("Chain Spark"),
                    text("lightning"),
                    integer(210),
                    integer(2),
                    integer(32),
                    boolean(false),
                ],
            ),
            row(
                "skill-sanctified-ray",
                vec![
                    text("sanctified-ray"),
                    text("Sanctified Ray"),
                    text("holy"),
                    integer(180),
                    integer(1),
                    integer(18),
                    boolean(false),
                ],
            ),
        ],
        vec![],
    );

    let enemies = formula_table(
        vec![
            column("enemy-id", "enemy_id", "text", true),
            column("enemy-name", "enemy_name", "text", false),
            column("level", "level", "number", false),
            column("defense", "defense", "number", false),
            column("hp", "hp", "number", false),
            column("element", "element", "text", false),
        ],
        vec![
            row(
                "enemy-moss-troll",
                vec![
                    text("moss-troll"),
                    text("Moss Troll"),
                    integer(18),
                    integer(36),
                    integer(950),
                    text("nature"),
                ],
            ),
            row(
                "enemy-ember-drake",
                vec![
                    text("ember-drake"),
                    text("Ember Drake"),
                    integer(22),
                    integer(54),
                    integer(1350),
                    text("fire"),
                ],
            ),
            row(
                "enemy-clockwork-knight",
                vec![
                    text("clockwork-knight"),
                    text("Clockwork Knight"),
                    integer(25),
                    integer(68),
                    integer(2100),
                    text("metal"),
                ],
            ),
            row(
                "enemy-wraith",
                vec![
                    text("wraith"),
                    text("Ashen Wraith"),
                    integer(24),
                    integer(40),
                    integer(800),
                    text("dark"),
                ],
            ),
        ],
        vec![],
    );

    let matchups = formula_table(
        vec![
            column("matchup-id", "matchup_id", "text", true),
            column("attacker", "attacker_element", "text", false),
            column("defender", "defender_element", "text", false),
            column("multiplier", "multiplier", "number", false),
        ],
        vec![
            row(
                "matchup-physical-nature",
                vec![
                    text("physical>nature"),
                    text("physical"),
                    text("nature"),
                    real(1.0),
                ],
            ),
            row(
                "matchup-fire-nature",
                vec![text("fire>nature"), text("fire"), text("nature"), real(1.5)],
            ),
            row(
                "matchup-ice-fire",
                vec![text("ice>fire"), text("ice"), text("fire"), real(1.5)],
            ),
            row(
                "matchup-lightning-metal",
                vec![
                    text("lightning>metal"),
                    text("lightning"),
                    text("metal"),
                    real(1.25),
                ],
            ),
            row(
                "matchup-holy-dark",
                vec![text("holy>dark"), text("holy"), text("dark"), real(1.5)],
            ),
        ],
        vec![],
    );

    let battle_specs = [
        (
            "troll-baseline",
            "Troll baseline",
            "vanguard",
            18,
            "cleave",
            "moss-troll",
        ),
        (
            "troll-weakness",
            "Exploit fire weakness",
            "vanguard",
            18,
            "flame-arc",
            "moss-troll",
        ),
        (
            "drake-counter",
            "Counter the drake",
            "ranger",
            20,
            "frost-volley",
            "ember-drake",
        ),
        (
            "armor-breaker",
            "Magic versus armor",
            "arcanist",
            22,
            "chain-spark",
            "clockwork-knight",
        ),
        (
            "undead-counter",
            "Holy versus undead",
            "cleric",
            24,
            "sanctified-ray",
            "wraith",
        ),
    ];
    let battle_row_ids = battle_specs
        .iter()
        .map(|(id, ..)| format!("case-{id}"))
        .collect::<Vec<_>>();
    let battle_rows = battle_specs
        .iter()
        .enumerate()
        .map(|(index, (id, scenario, job, level, skill, enemy))| {
            let number = index + 1;
            row(
                format!("case-{id}"),
                vec![
                    text(id),
                    text(scenario),
                    direct_ref("jobs", job, "job_id"),
                    direct_ref("jobs", job, "job_name"),
                    integer(*level),
                    direct_ref("skills", skill, "skill_id"),
                    direct_ref("skills", skill, "skill_name"),
                    direct_ref("enemies", enemy, "enemy_id"),
                    direct_ref("enemies", enemy, "enemy_name"),
                    formula(format!(
                        "ROUND(REF(\"jobs\", C{number}, \"base_attack\") + REF(\"jobs\", C{number}, \"attack_growth\") * (E{number} - 1), 0)"
                    )),
                    formula(format!("REF(\"skills\", F{number}, \"skill_power\")")),
                    formula(format!("REF(\"enemies\", H{number}, \"defense\")")),
                    formula(format!(
                        "REF(\"element-matchups\", CONCAT(REF(\"skills\", F{number}, \"element\"), \">\", REF(\"enemies\", H{number}, \"element\")), \"multiplier\")"
                    )),
                    formula(format!(
                        "MAX(1, ROUND((J{number} * K{number} / 100 - L{number}) * M{number}, 0))"
                    )),
                    formula(format!(
                        "N{number} * REF(\"skills\", F{number}, \"hit_count\")"
                    )),
                    formula(format!("REF(\"enemies\", H{number}, \"hp\")")),
                    formula(format!("CEILING(P{number} / O{number}, 1)")),
                    formula(format!(
                        "ROUND(O{number} / REF(\"skills\", F{number}, \"mp_cost\"), 2)"
                    )),
                    formula(format!(
                        "IF(O{number} >= P{number}, \"burst risk\", IF(Q{number} > 5, \"too slow\", \"target range\"))"
                    )),
                ],
            )
        })
        .collect::<Vec<_>>();
    let battle_cases = formula_table(
        vec![
            column("case-id", "case_id", "text", true),
            column("scenario", "scenario", "text", false),
            column("job-id", "job_id", "text", false),
            column("job-name", "job_name", "text", false),
            column("level", "level", "number", false),
            column("skill-id", "skill_id", "text", false),
            column("skill-name", "skill_name", "text", false),
            column("enemy-id", "enemy_id", "text", false),
            column("enemy-name", "enemy_name", "text", false),
            column("attack", "attack", "number", false),
            column("skill-power", "skill_power", "number", false),
            column("enemy-defense", "enemy_defense", "number", false),
            column("element-multiplier", "element_multiplier", "number", false),
            column("damage-per-hit", "damage_per_hit", "number", false),
            column("total-damage", "total_damage", "number", false),
            column("enemy-hp", "enemy_hp", "number", false),
            column("turns", "turns_to_defeat", "number", false),
            column("damage-per-mp", "damage_per_mp", "number", false),
            column("balance-note", "balance_note", "text", false),
        ],
        battle_rows,
        vec![
            reference_group(
                "battle-job-selection",
                "jobs",
                battle_row_ids.clone(),
                &[("job-id", "job-id"), ("job-name", "job-name")],
            ),
            reference_group(
                "battle-skill-selection",
                "skills",
                battle_row_ids.clone(),
                &[("skill-id", "skill-id"), ("skill-name", "skill-name")],
            ),
            reference_group(
                "battle-enemy-selection",
                "enemies",
                battle_row_ids,
                &[("enemy-id", "enemy-id"), ("enemy-name", "enemy-name")],
            ),
        ],
    );

    let sources = json!({
        "jobs": jobs,
        "skills": skills,
        "enemies": enemies,
        "element-matchups": matchups,
        "battle-cases": battle_cases,
        "battle-report": rhai_source(
            BATTLE_REPORT_PATH,
            &[("battle_cases", "battle-cases")],
            &["scenario", "matchup", "total_damage", "enemy_hp", "turns_to_defeat", "damage_per_mp", "balance_note"]
        )
    });
    let markdown = format!(
        "# RPG Battle Balance Lab\n\n\
         ## Purpose\n\n\
         Tune jobs, skills, enemies, and elemental counters as connected game data. The battle cases are managed Formula sheets; the compact comparison at the end is generated by a sandboxed, read-only Rhai report.\n\n\
         ## Try it\n\n\
         - Change a job's `attack_growth` and watch every linked case recalculate.\n\
         - In `battle-cases`, use a reference picker to swap a job, skill, or enemy while keeping its ID and name aligned.\n\
         - Change `fire>nature` in the matchup table from `1.5` to `1.25` and compare the weakness case.\n\
         - Duplicate a battle case and create a new matchup. `CEILING` turns fractional kill counts into whole turns.\n\n\
         ## Job master\n\n{}\n\
         ## Skill master\n\n{}\n\
         ## Enemy master\n\n{}\n\
         ## Element matchups\n\n{}\n\
         ## Battle cases\n\n{}\n\
         ## Read-only balance report\n\n\
         This view is derived from the cases above. Edit the source sheets, not the report.\n\n{}",
        data_view("jobs"),
        data_view("skills"),
        data_view("enemies"),
        data_view("element-matchups"),
        data_view("battle-cases"),
        data_view("battle-report")
    );
    let mut doc = new_document("RPG Battle Balance Lab", markdown, sources)?;
    attach_script(&mut doc, BATTLE_REPORT_PATH, BATTLE_REPORT)?;
    Ok(doc)
}

fn growth_document() -> Result<TmdDoc, Box<dyn Error>> {
    let profiles = formula_table(
        vec![
            column("profile-id", "profile_id", "text", true),
            column("profile-name", "profile_name", "text", false),
            column("base-hp", "base_hp", "number", false),
            column("hp-linear", "hp_linear", "number", false),
            column("hp-quadratic", "hp_quadratic", "number", false),
            column("base-attack", "base_attack", "number", false),
            column("attack-scale", "attack_scale", "number", false),
            column("exp-base", "exp_base", "number", false),
            column("exp-exponent", "exp_exponent", "number", false),
        ],
        vec![
            row(
                "profile-guardian",
                vec![
                    text("guardian"),
                    text("Guardian"),
                    integer(180),
                    integer(32),
                    real(1.8),
                    integer(18),
                    real(3.1),
                    integer(90),
                    real(1.42),
                ],
            ),
            row(
                "profile-striker",
                vec![
                    text("striker"),
                    text("Striker"),
                    integer(120),
                    integer(22),
                    real(1.2),
                    integer(26),
                    real(4.5),
                    integer(85),
                    real(1.48),
                ],
            ),
            row(
                "profile-mystic",
                vec![
                    text("mystic"),
                    text("Mystic"),
                    integer(100),
                    integer(18),
                    real(0.9),
                    integer(30),
                    real(5.2),
                    integer(100),
                    real(1.5),
                ],
            ),
        ],
        vec![],
    );

    let profile_specs = [
        ("guardian", "Guardian"),
        ("striker", "Striker"),
        ("mystic", "Mystic"),
    ];
    let mut curve_rows = Vec::new();
    let mut curve_row_ids = Vec::new();
    for (profile_index, (profile_id, _)) in profile_specs.iter().enumerate() {
        for level in 1..=12 {
            let table_row = profile_index * 12 + level;
            let row_id = format!("curve-{profile_id}-{level}");
            curve_row_ids.push(row_id.clone());
            let cumulative = if level == 1 {
                integer(0)
            } else {
                formula(format!("H{} + G{}", table_row - 1, table_row - 1))
            };
            curve_rows.push(row(
                row_id,
                vec![
                    text(&format!("{profile_id}-lv-{level:02}")),
                    direct_ref("growth-profiles", profile_id, "profile_id"),
                    direct_ref("growth-profiles", profile_id, "profile_name"),
                    integer(level as i64),
                    formula(format!(
                        "ROUND(REF(\"growth-profiles\", B{table_row}, \"base_hp\") + REF(\"growth-profiles\", B{table_row}, \"hp_linear\") * (D{table_row} - 1) + REF(\"growth-profiles\", B{table_row}, \"hp_quadratic\") * POWER(D{table_row} - 1, 2), 0)"
                    )),
                    formula(format!(
                        "FLOOR(REF(\"growth-profiles\", B{table_row}, \"base_attack\") + REF(\"growth-profiles\", B{table_row}, \"attack_scale\") * POWER(D{table_row} - 1, 1.18), 1)"
                    )),
                    formula(format!(
                        "CEILING(REF(\"growth-profiles\", B{table_row}, \"exp_base\") * POWER(D{table_row}, REF(\"growth-profiles\", B{table_row}, \"exp_exponent\")), 50)"
                    )),
                    cumulative,
                    formula(format!("ROUND(E{table_row} * F{table_row} / 100, 1)")),
                    formula(format!(
                        "IF(D{table_row} <= 4, \"early\", IF(D{table_row} <= 8, \"mid\", \"late\"))"
                    )),
                ],
            ));
        }
    }
    let level_curve = formula_table(
        vec![
            column("curve-id", "curve_id", "text", true),
            column("profile-id", "profile_id", "text", false),
            column("profile-name", "profile_name", "text", false),
            column("level", "level", "number", false),
            column("max-hp", "max_hp", "number", false),
            column("attack", "attack", "number", false),
            column("required-exp", "required_exp", "number", false),
            column("cumulative-exp", "cumulative_exp", "number", false),
            column("power-index", "power_index", "number", false),
            column("growth-band", "growth_band", "text", false),
        ],
        curve_rows,
        vec![reference_group(
            "growth-profile-selection",
            "growth-profiles",
            curve_row_ids,
            &[
                ("profile-id", "profile-id"),
                ("profile-name", "profile-name"),
            ],
        )],
    );

    let sources = json!({
        "growth-profiles": profiles,
        "level-curve": level_curve,
        "growth-report": rhai_source(
            GROWTH_REPORT_PATH,
            &[("level_curve", "level-curve")],
            &["profile", "level", "max_hp", "attack", "required_exp", "cumulative_exp", "power_index", "growth_band"]
        )
    });
    let markdown = format!(
        "# RPG Level Growth Curves\n\n\
         ## Purpose\n\n\
         Shape distinct class growth curves and XP pacing from a small parameter master. The full level sheet is editable and deterministic; the final Rhai view extracts design-review milestones.\n\n\
         ## Try it\n\n\
         - Raise the Guardian's `hp_quadratic` and compare late-level HP and `power_index`.\n\
         - Lower the Mystic's `exp_exponent` to soften its progression cost.\n\
         - Change a curve row's profile with the reference picker and see all `REF`-based parameters follow it.\n\
         - Inspect how `POWER` shapes nonlinear growth, while `FLOOR` and `CEILING` quantize player-facing values.\n\n\
         ## Growth profiles\n\n{}\n\
         ## Complete level curve\n\n{}\n\
         ## Read-only milestone report\n\n\
         Levels 1, 5, 10, and 12 are selected by Rhai for a compact review.\n\n{}",
        data_view("growth-profiles"),
        data_view("level-curve"),
        data_view("growth-report")
    );
    let mut doc = new_document("RPG Level Growth Curves", markdown, sources)?;
    attach_script(&mut doc, GROWTH_REPORT_PATH, GROWTH_REPORT)?;
    Ok(doc)
}

fn economy_document() -> Result<TmdDoc, Box<dyn Error>> {
    let items = formula_table(
        vec![
            column("item-id", "item_id", "text", true),
            column("item-name", "item_name", "text", false),
            column("category", "category", "text", false),
            column("buy-price", "buy_price", "number", false),
            column("sell-price", "sell_price", "number", false),
            column("rarity", "rarity", "text", false),
        ],
        vec![
            row(
                "item-iron-sword",
                vec![
                    text("iron-sword"),
                    text("Iron Sword"),
                    text("weapon"),
                    integer(0),
                    integer(260),
                    text("common"),
                ],
            ),
            row(
                "item-mana-potion",
                vec![
                    text("mana-potion"),
                    text("Mana Potion"),
                    text("consumable"),
                    integer(0),
                    integer(95),
                    text("common"),
                ],
            ),
            row(
                "item-phoenix-tonic",
                vec![
                    text("phoenix-tonic"),
                    text("Phoenix Tonic"),
                    text("consumable"),
                    integer(0),
                    integer(420),
                    text("epic"),
                ],
            ),
            row(
                "item-iron-ingot",
                vec![
                    text("iron-ingot"),
                    text("Iron Ingot"),
                    text("material"),
                    integer(50),
                    integer(25),
                    text("common"),
                ],
            ),
            row(
                "item-leather-strip",
                vec![
                    text("leather-strip"),
                    text("Leather Strip"),
                    text("material"),
                    integer(12),
                    integer(6),
                    text("common"),
                ],
            ),
            row(
                "item-mana-herb",
                vec![
                    text("mana-herb"),
                    text("Mana Herb"),
                    text("material"),
                    integer(18),
                    integer(9),
                    text("common"),
                ],
            ),
            row(
                "item-spring-water",
                vec![
                    text("spring-water"),
                    text("Spring Water"),
                    text("material"),
                    integer(2),
                    integer(1),
                    text("common"),
                ],
            ),
            row(
                "item-ember-feather",
                vec![
                    text("ember-feather"),
                    text("Ember Feather"),
                    text("material"),
                    integer(90),
                    integer(55),
                    text("rare"),
                ],
            ),
            row(
                "item-crystal-dust",
                vec![
                    text("crystal-dust"),
                    text("Crystal Dust"),
                    text("material"),
                    integer(40),
                    integer(24),
                    text("rare"),
                ],
            ),
            row(
                "item-ancient-token",
                vec![
                    text("ancient-token"),
                    text("Ancient Token"),
                    text("treasure"),
                    integer(0),
                    integer(180),
                    text("epic"),
                ],
            ),
        ],
        vec![],
    );

    let recipe_specs = [
        ("forge-iron-sword", "iron-sword", 1, 15, "forge"),
        ("brew-mana-potion", "mana-potion", 2, 5, "alchemist bench"),
        (
            "brew-phoenix-tonic",
            "phoenix-tonic",
            1,
            30,
            "alchemist bench",
        ),
    ];
    let recipe_row_ids = recipe_specs
        .iter()
        .map(|(id, ..)| format!("recipe-{id}"))
        .collect::<Vec<_>>();
    let recipe_rows = recipe_specs
        .iter()
        .map(|(id, item_id, quantity, fee, station)| {
            row(
                format!("recipe-{id}"),
                vec![
                    text(id),
                    direct_ref("items", item_id, "item_id"),
                    direct_ref("items", item_id, "item_name"),
                    direct_ref("items", item_id, "sell_price"),
                    integer(*quantity),
                    integer(*fee),
                    text(station),
                ],
            )
        })
        .collect::<Vec<_>>();
    let recipes = formula_table(
        vec![
            column("recipe-id", "recipe_id", "text", true),
            column("result-item-id", "result_item_id", "text", false),
            column("result-name", "result_name", "text", false),
            column("result-sell-price", "result_sell_price", "number", false),
            column("result-quantity", "result_quantity", "number", false),
            column("crafting-fee", "crafting_fee", "number", false),
            column("station", "station", "text", false),
        ],
        recipe_rows,
        vec![reference_group(
            "recipe-result-selection",
            "items",
            recipe_row_ids,
            &[
                ("result-item-id", "item-id"),
                ("result-name", "item-name"),
                ("result-sell-price", "sell-price"),
            ],
        )],
    );

    let material_specs = [
        ("sword-ingot", "forge-iron-sword", "iron-ingot", 3),
        ("sword-leather", "forge-iron-sword", "leather-strip", 1),
        ("mana-herb", "brew-mana-potion", "mana-herb", 3),
        ("mana-water", "brew-mana-potion", "spring-water", 2),
        ("tonic-feather", "brew-phoenix-tonic", "ember-feather", 2),
        ("tonic-dust", "brew-phoenix-tonic", "crystal-dust", 3),
        ("tonic-water", "brew-phoenix-tonic", "spring-water", 1),
    ];
    let material_row_ids = material_specs
        .iter()
        .map(|(id, ..)| format!("material-{id}"))
        .collect::<Vec<_>>();
    let material_rows = material_specs
        .iter()
        .enumerate()
        .map(|(index, (id, recipe_id, material_id, quantity))| {
            let number = index + 1;
            row(
                format!("material-{id}"),
                vec![
                    text(id),
                    direct_ref("recipes", recipe_id, "recipe_id"),
                    direct_ref("recipes", recipe_id, "result_name"),
                    direct_ref("items", material_id, "item_id"),
                    direct_ref("items", material_id, "item_name"),
                    direct_ref("items", material_id, "buy_price"),
                    integer(*quantity),
                    formula(format!("F{number} * G{number}")),
                ],
            )
        })
        .collect::<Vec<_>>();
    let material_lines = formula_table(
        vec![
            column("line-id", "line_id", "text", true),
            column("recipe-id", "recipe_id", "text", false),
            column("recipe-name", "recipe_name", "text", false),
            column("material-item-id", "material_item_id", "text", false),
            column("material-name", "material_name", "text", false),
            column("unit-price", "unit_price", "number", false),
            column("quantity", "quantity", "number", false),
            column("material-cost", "material_cost", "number", false),
        ],
        material_rows,
        vec![
            reference_group(
                "material-recipe-selection",
                "recipes",
                material_row_ids.clone(),
                &[("recipe-id", "recipe-id"), ("recipe-name", "result-name")],
            ),
            reference_group(
                "material-item-selection",
                "items",
                material_row_ids,
                &[
                    ("material-item-id", "item-id"),
                    ("material-name", "item-name"),
                    ("unit-price", "buy-price"),
                ],
            ),
        ],
    );

    let loot_specs = [
        ("forest-herb", "forest-goblin", "mana-herb", 0.65, 1, 2),
        ("forest-water", "forest-goblin", "spring-water", 0.30, 1, 3),
        ("forest-token", "forest-goblin", "ancient-token", 0.05, 1, 1),
        ("ruins-dust", "ancient-ruins", "crystal-dust", 0.60, 1, 2),
        (
            "ruins-feather",
            "ancient-ruins",
            "ember-feather",
            0.30,
            1,
            1,
        ),
        ("ruins-token", "ancient-ruins", "ancient-token", 0.10, 1, 1),
    ];
    let loot_row_ids = loot_specs
        .iter()
        .map(|(id, ..)| format!("loot-{id}"))
        .collect::<Vec<_>>();
    let loot_rows = loot_specs
        .iter()
        .enumerate()
        .map(
            |(index, (id, table, item_id, probability, min_quantity, max_quantity))| {
                let number = index + 1;
                row(
                    format!("loot-{id}"),
                    vec![
                        text(id),
                        text(table),
                        direct_ref("items", item_id, "item_id"),
                        direct_ref("items", item_id, "item_name"),
                        direct_ref("items", item_id, "sell_price"),
                        real(*probability),
                        integer(*min_quantity),
                        integer(*max_quantity),
                        formula(format!("ROUND(F{number} * (G{number} + H{number}) / 2, 3)")),
                        formula(format!("ROUND(I{number} * E{number}, 2)")),
                    ],
                )
            },
        )
        .collect::<Vec<_>>();
    let loot_entries = formula_table(
        vec![
            column("loot-id", "loot_id", "text", true),
            column("loot-table", "loot_table", "text", false),
            column("item-id", "item_id", "text", false),
            column("item-name", "item_name", "text", false),
            column("sell-price", "sell_price", "number", false),
            column("probability", "probability", "number", false),
            column("min-quantity", "min_quantity", "number", false),
            column("max-quantity", "max_quantity", "number", false),
            column("expected-quantity", "expected_quantity", "number", false),
            column("expected-value", "expected_value", "number", false),
        ],
        loot_rows,
        vec![reference_group(
            "loot-item-selection",
            "items",
            loot_row_ids,
            &[
                ("item-id", "item-id"),
                ("item-name", "item-name"),
                ("sell-price", "sell-price"),
            ],
        )],
    );

    let sources = json!({
        "items": items,
        "recipes": recipes,
        "recipe-materials": material_lines,
        "loot-entries": loot_entries,
        "economy-report": rhai_source(
            ECONOMY_REPORT_PATH,
            &[
                ("recipes", "recipes"),
                ("material_lines", "recipe-materials"),
                ("loot_entries", "loot-entries")
            ],
            &[
                "section",
                "entry",
                "cost_or_expected_value",
                "revenue_or_probability_pct",
                "margin_or_probability_gap",
                "status"
            ]
        )
    });
    let markdown = format!(
        "# RPG Crafting and Loot Economy\n\n\
         ## Purpose\n\n\
         Balance item prices, normalized crafting recipes, and probabilistic loot in one connected workbook. Formula sheets calculate line-level costs and expected values; Rhai performs cross-table aggregation without making the report editable.\n\n\
         ## Try it\n\n\
         - Change `Iron Ingot.buy_price` and observe the sword material line and crafting margin.\n\
         - Use a reference picker to replace a recipe material; ID, name, and price move together.\n\
         - Make a loot table total more or less than 100% and look for `probability mismatch`.\n\
         - Raise a result item's `sell_price` and compare batch revenue with aggregated material cost.\n\n\
         ## Item master\n\n{}\n\
         ## Recipe headers\n\n{}\n\
         ## Recipe material lines\n\n{}\n\
         ## Loot entries\n\n{}\n\
         ## Read-only economy audit\n\n\
         Crafting rows compare batch cost and revenue. Loot rows show expected value and total probability percentage.\n\n{}",
        data_view("items"),
        data_view("recipes"),
        data_view("recipe-materials"),
        data_view("loot-entries"),
        data_view("economy-report")
    );
    let mut doc = new_document("RPG Crafting and Loot Economy", markdown, sources)?;
    attach_script(&mut doc, ECONOMY_REPORT_PATH, ECONOMY_REPORT)?;
    Ok(doc)
}

fn main() -> Result<(), Box<dyn Error>> {
    let sample_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tmd-sample");
    verify_and_write(
        &battle_document()?,
        &sample_dir.join("rpg-battle-balance.tmd"),
    )?;
    verify_and_write(
        &growth_document()?,
        &sample_dir.join("rpg-level-growth.tmd"),
    )?;
    verify_and_write(&economy_document()?, &sample_dir.join("rpg-economy.tmd"))?;
    Ok(())
}
