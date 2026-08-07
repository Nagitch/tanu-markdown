use tmd_data::{DataScalar, DataTable};
use tmd_formula::{
    evaluate_formula_program, evaluate_formula_program_with_limits, parse_formula_program, CellRef,
    FormulaEvaluationLimits,
};

fn input_table() -> DataTable {
    DataTable {
        columns: vec!["item".to_owned(), "amount".to_owned()],
        rows: vec![
            vec![
                DataScalar::String("books".to_owned()),
                DataScalar::Integer(10),
            ],
            vec![
                DataScalar::String("games".to_owned()),
                DataScalar::Integer(20),
            ],
        ],
    }
}

#[test]
fn public_engine_evaluates_without_tmd_core() {
    let program = parse_formula_program("C1 = B1 * 2\nC2 = SUM(B1:B2)").expect("program");
    assert_eq!(program.assignment_count(), 2);

    let output = evaluate_formula_program(
        &program,
        &input_table(),
        &["item".to_owned(), "amount".to_owned(), "result".to_owned()],
    )
    .expect("Formula output");

    assert_eq!(output.rows[0][2], DataScalar::Integer(20));
    assert_eq!(output.rows[1][2], DataScalar::Integer(30));
}

#[test]
fn public_error_exposes_structured_location_and_target() {
    let program = parse_formula_program("A1 = 1").expect("syntax");
    let error = evaluate_formula_program(
        &program,
        &input_table(),
        &["item".to_owned(), "amount".to_owned()],
    )
    .expect_err("input overwrite");

    assert_eq!(error.code(), "#REF!");
    assert_eq!(error.line(), 1);
    assert_eq!(error.column(), 1);
    assert!(error.end_column() > error.column());
    assert_eq!(error.target(), CellRef::from_indexes(0, 0));
    assert_eq!(error.target().expect("target").to_string(), "A1");
    assert_eq!(
        error.message(),
        "formula targets cannot overwrite the input table"
    );
    assert_eq!(CellRef::from_indexes(usize::MAX, 0), None);
}

#[test]
fn caller_controls_output_table_limits() {
    let program = parse_formula_program("C3 = 1").expect("program");
    let limits = FormulaEvaluationLimits::new(2, 10);
    assert_eq!(limits.max_table_rows(), 2);
    assert_eq!(limits.max_table_cells(), 10);

    let error = evaluate_formula_program_with_limits(
        &program,
        &input_table(),
        &["item".to_owned(), "amount".to_owned(), "result".to_owned()],
        limits,
    )
    .expect_err("row limit");
    assert_eq!(error.code(), "#LIMIT!");
}
