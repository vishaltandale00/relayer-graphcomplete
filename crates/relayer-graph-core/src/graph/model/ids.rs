use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

macro_rules! integer_id {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(i64);

        impl $name {
            pub fn new(value: i64) -> Option<Self> {
                (value > 0).then_some(Self(value))
            }

            pub fn value(self) -> i64 {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = i64::deserialize(deserializer)?;
                Self::new(value).ok_or_else(|| {
                    D::Error::custom(concat!(stringify!($name), " must be a positive integer"))
                })
            }
        }
    };
}

integer_id!(ProjectId);
integer_id!(ThreadId);
integer_id!(NodeId);
integer_id!(EdgeId);
integer_id!(LayerId);
integer_id!(ActionId);
