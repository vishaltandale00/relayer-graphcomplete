use thiserror::Error;

macro_rules! product_id {
    ($name:ident, $label:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub(crate) struct $name(i64);

        impl $name {
            pub(crate) fn value(self) -> i64 {
                self.0
            }

            pub(crate) fn from_database(value: i64) -> Self {
                debug_assert!(value > 0, "{} must be positive", $label);
                Self(value)
            }
        }

        impl TryFrom<i64> for $name {
            type Error = InvalidProductId;

            fn try_from(value: i64) -> Result<Self, Self::Error> {
                if value > 0 {
                    Ok(Self(value))
                } else {
                    Err(InvalidProductId { label: $label })
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(formatter)
            }
        }
    };
}

#[derive(Debug, Error)]
#[error("{label} must be a positive integer")]
pub(crate) struct InvalidProductId {
    label: &'static str,
}

product_id!(ProjectId, "project id");
product_id!(ThreadId, "thread id");
product_id!(InteractionId, "interaction id");
