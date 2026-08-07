//! Transport-neutral scalar and ordered-table values.

use serde::{Deserialize, Serialize};

/// Scalar value shared by data-source adapters and computation engines.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum DataScalar {
    /// SQL or structured-data null.
    Null,
    /// Boolean value.
    Boolean(bool),
    /// Signed 64-bit integer.
    Integer(i64),
    /// Finite floating-point number.
    Real(f64),
    /// UTF-8 string.
    String(String),
}

impl DataScalar {
    /// Convert the scalar to its passive display representation.
    #[must_use]
    pub fn display_text(&self) -> String {
        match self {
            Self::Null => "NULL".to_owned(),
            Self::Boolean(value) => value.to_string(),
            Self::Integer(value) => value.to_string(),
            Self::Real(value) => value.to_string(),
            Self::String(value) => value.clone(),
        }
    }
}

/// Ordered table returned by a tabular data source or computation engine.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DataTable {
    /// Ordered result-column labels.
    pub columns: Vec<String>,
    /// Ordered result rows containing scalar cells.
    pub rows: Vec<Vec<DataScalar>>,
}

#[cfg(test)]
mod tests {
    use super::DataScalar;

    #[test]
    fn formats_passive_scalar_text() {
        assert_eq!(DataScalar::Null.display_text(), "NULL");
        assert_eq!(DataScalar::Boolean(true).display_text(), "true");
        assert_eq!(DataScalar::Integer(42).display_text(), "42");
        assert_eq!(DataScalar::Real(1.5).display_text(), "1.5");
        assert_eq!(DataScalar::String("text".to_owned()).display_text(), "text");
    }
}
