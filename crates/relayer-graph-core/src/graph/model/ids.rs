use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

/// Standalone graph thread reserved for product-owned personal-presentation
/// versions. Ordinary interaction creation rejects this identity; only the
/// dedicated profile creation boundary may use it.
pub const PERSONAL_PRESENTATION_PROFILE_THREAD_ID: i64 = i64::MAX;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InteractionInputChildId(i64);

impl InteractionInputChildId {
    pub fn new(value: i64) -> Option<Self> {
        (value > 0).then_some(Self(value))
    }
}

impl fmt::Display for InteractionInputChildId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "interaction-input-child:{}", self.0)
    }
}

impl Serialize for InteractionInputChildId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for InteractionInputChildId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let raw = value
            .strip_prefix("interaction-input-child:")
            .ok_or_else(|| D::Error::custom("InteractionInputChildId has an invalid namespace"))?
            .parse::<i64>()
            .map_err(D::Error::custom)?;
        Self::new(raw)
            .ok_or_else(|| D::Error::custom("InteractionInputChildId must be a positive integer"))
    }
}
