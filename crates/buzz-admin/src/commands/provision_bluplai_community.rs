use buzz_db::{Db, EnsuredCommunityRecord};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use url::Url;

const HOST_PREFIX: &str = "org-";
const HOST_HASH_BYTES: usize = 20;
const MIN_CHAT_KEY_LEN: usize = 32;
const MAX_CHAT_KEY_LEN: usize = 128;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ProductionDeployment<'a> {
    pub image: &'a str,
    pub caddy_image: &'a str,
    pub database_url: &'a str,
    pub redis_url: &'a str,
    pub s3_endpoint: &'a str,
    pub s3_access_key: &'a str,
    pub s3_secret_key: &'a str,
    pub s3_bucket: &'a str,
    pub s3_addressing_style: &'a str,
    pub require_auth_token: bool,
    pub require_relay_membership: bool,
    pub cors_origins: &'a str,
    pub browser_origin: &'a str,
    pub auto_migrate: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ProvisioningConfig {
    pub environment: String,
    pub base_domain: String,
    pub image: String,
    pub caddy_image: String,
    pub database_url: String,
    pub redis_url: String,
    pub s3_endpoint: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_bucket: String,
    pub s3_addressing_style: String,
    pub require_auth_token: bool,
    pub require_relay_membership: bool,
    pub cors_origins: String,
    pub browser_origin: String,
    pub auto_migrate: bool,
}

impl ProvisioningConfig {
    pub(crate) fn from_env() -> Result<Self, String> {
        Ok(Self {
            environment: required_env("BLUPLAI_ENVIRONMENT")?,
            base_domain: required_env("BLUPLAI_COMMUNITY_BASE_DOMAIN")?,
            image: required_env("BUZZ_IMAGE")?,
            caddy_image: required_env("CADDY_IMAGE")?,
            database_url: required_env("DATABASE_URL")?,
            redis_url: required_env("REDIS_URL")?,
            s3_endpoint: required_env("BUZZ_S3_ENDPOINT")?,
            s3_access_key: required_env("BUZZ_S3_ACCESS_KEY")?,
            s3_secret_key: required_env("BUZZ_S3_SECRET_KEY")?,
            s3_bucket: required_env("BUZZ_S3_BUCKET")?,
            s3_addressing_style: required_env("BUZZ_S3_ADDRESSING_STYLE")?,
            require_auth_token: required_bool_env("BUZZ_REQUIRE_AUTH_TOKEN")?,
            require_relay_membership: required_bool_env("BUZZ_REQUIRE_RELAY_MEMBERSHIP")?,
            cors_origins: required_env("BUZZ_CORS_ORIGINS")?,
            browser_origin: required_env("BLUPLAI_BROWSER_ORIGIN")?,
            auto_migrate: required_bool_env("BUZZ_AUTO_MIGRATE")?,
        })
    }

    pub(crate) fn deployment(&self) -> ProductionDeployment<'_> {
        ProductionDeployment {
            image: &self.image,
            caddy_image: &self.caddy_image,
            database_url: &self.database_url,
            redis_url: &self.redis_url,
            s3_endpoint: &self.s3_endpoint,
            s3_access_key: &self.s3_access_key,
            s3_secret_key: &self.s3_secret_key,
            s3_bucket: &self.s3_bucket,
            s3_addressing_style: &self.s3_addressing_style,
            require_auth_token: self.require_auth_token,
            require_relay_membership: self.require_relay_membership,
            cors_origins: &self.cors_origins,
            browser_origin: &self.browser_origin,
            auto_migrate: self.auto_migrate,
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ProvisionedCommunity {
    pub community_id: String,
    pub host: String,
    pub status: &'static str,
}

pub(crate) fn derive_community_host(
    organization_chat_key: &str,
    environment: &str,
    base_domain: &str,
) -> Result<String, String> {
    validate_chat_key(organization_chat_key)?;
    validate_dns_label(environment, "environment")?;
    validate_base_domain(base_domain)?;

    let mut hasher = Sha256::new();
    hasher.update(b"bluplai-community-host-v1\0");
    hasher.update(environment.as_bytes());
    hasher.update(b"\0");
    hasher.update(organization_chat_key.as_bytes());
    let digest = hasher.finalize();
    let opaque_label = hex::encode(&digest[..HOST_HASH_BYTES]);
    Ok(format!("{HOST_PREFIX}{opaque_label}.{base_domain}"))
}

pub(crate) fn validate_production_deployment(
    deployment: ProductionDeployment<'_>,
) -> Result<(), String> {
    validate_digest_pinned_image(deployment.image, "BUZZ_IMAGE")?;
    validate_digest_pinned_image(deployment.caddy_image, "CADDY_IMAGE")?;
    validate_postgres_url(deployment.database_url)?;
    validate_redis_url(deployment.redis_url)?;
    validate_s3_endpoint(deployment.s3_endpoint)?;
    validate_nonempty_secret(deployment.s3_access_key, "BUZZ_S3_ACCESS_KEY")?;
    validate_nonempty_secret(deployment.s3_secret_key, "BUZZ_S3_SECRET_KEY")?;
    validate_s3_bucket(deployment.s3_bucket)?;
    if !matches!(deployment.s3_addressing_style, "path" | "virtual") {
        return Err("BUZZ_S3_ADDRESSING_STYLE must be exactly 'path' or 'virtual'".to_string());
    }
    if !deployment.require_auth_token {
        return Err("BUZZ_REQUIRE_AUTH_TOKEN must be true in production".to_string());
    }
    if !deployment.require_relay_membership {
        return Err("BUZZ_REQUIRE_RELAY_MEMBERSHIP must be true in production".to_string());
    }
    if deployment.auto_migrate {
        return Err(
            "BUZZ_AUTO_MIGRATE must be false; run the explicit migrate job before relay rollout"
                .to_string(),
        );
    }
    validate_https_origin(deployment.browser_origin, "BLUPLAI_BROWSER_ORIGIN")?;
    if deployment.cors_origins != deployment.browser_origin {
        return Err("BUZZ_CORS_ORIGINS must contain exactly BLUPLAI_BROWSER_ORIGIN".to_string());
    }
    Ok(())
}

pub(crate) async fn provision(
    db: &Db,
    organization_chat_key: &str,
    config: &ProvisioningConfig,
) -> Result<ProvisionedCommunity, String> {
    validate_production_deployment(config.deployment())?;
    let host = derive_community_host(
        organization_chat_key,
        &config.environment,
        &config.base_domain,
    )?;
    let EnsuredCommunityRecord { id, host, created } = db
        .ensure_configured_community(&host)
        .await
        .map_err(|error| format!("community persistence failed: {error}"))?;
    Ok(ProvisionedCommunity {
        community_id: id.to_string(),
        host,
        status: if created { "created" } else { "existing" },
    })
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .map_err(|_| format!("{name} is required"))
        .and_then(|value| {
            let value = value.trim().to_string();
            if value.is_empty() {
                Err(format!("{name} must not be empty"))
            } else {
                Ok(value)
            }
        })
}

fn required_bool_env(name: &str) -> Result<bool, String> {
    match required_env(name)?.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("{name} must be exactly 'true' or 'false'")),
    }
}

fn validate_chat_key(value: &str) -> Result<(), String> {
    if !(MIN_CHAT_KEY_LEN..=MAX_CHAT_KEY_LEN).contains(&value.len()) {
        return Err(format!(
            "organization chat key must be {MIN_CHAT_KEY_LEN}..={MAX_CHAT_KEY_LEN} ASCII characters"
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(
            "organization chat key must contain only ASCII letters, digits, '_' or '-'".to_string(),
        );
    }
    Ok(())
}

fn validate_dns_label(value: &str, name: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 63 {
        return Err(format!("{name} must be a non-empty DNS label"));
    }
    if value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!("{name} must be a canonical lowercase DNS label"));
    }
    Ok(())
}

fn validate_base_domain(value: &str) -> Result<(), String> {
    if value.len() > 253 || !value.contains('.') {
        return Err("base domain must be a canonical multi-label DNS name".to_string());
    }
    if value.contains([':', '/', '@', '*']) || value.ends_with('.') {
        return Err(
            "base domain must not contain a scheme, port, wildcard, or trailing dot".to_string(),
        );
    }
    for label in value.split('.') {
        validate_dns_label(label, "base domain label")?;
    }
    Ok(())
}

fn validate_digest_pinned_image(image: &str, name: &str) -> Result<(), String> {
    let Some((repository, digest)) = image.rsplit_once("@sha256:") else {
        return Err(format!("{name} must be pinned by a sha256 digest"));
    };
    if repository.is_empty()
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{name} must end in @sha256:<64 lowercase hex characters>"
        ));
    }
    Ok(())
}

fn validate_external_service_url(
    value: &str,
    name: &str,
    allowed_schemes: &[&str],
) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| format!("{name} must be a valid service URL"))?;
    if !allowed_schemes.contains(&url.scheme()) {
        return Err(format!("{name} uses an unsupported URL scheme"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| format!("{name} must include a host"))?;
    validate_external_host(host, name)
}

fn validate_postgres_url(value: &str) -> Result<(), String> {
    validate_external_service_url(value, "DATABASE_URL", &["postgres", "postgresql"])?;
    let url = Url::parse(value).map_err(|_| "DATABASE_URL must be a valid service URL")?;
    let secure = url.query_pairs().any(|(key, mode)| {
        key == "sslmode" && matches!(mode.as_ref(), "require" | "verify-ca" | "verify-full")
    });
    if secure {
        Ok(())
    } else {
        Err(
            "DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full"
                .to_string(),
        )
    }
}

fn validate_redis_url(value: &str) -> Result<(), String> {
    validate_external_service_url(value, "REDIS_URL", &["rediss"])
}

fn validate_external_host(host: &str, name: &str) -> Result<(), String> {
    let canonical = host.to_ascii_lowercase();
    if matches!(
        canonical.as_str(),
        "localhost" | "postgres" | "redis" | "minio" | "relay"
    ) || canonical.ends_with(".localhost")
        || canonical.ends_with(".local")
    {
        return Err(format!("{name} must point to an external durable service"));
    }
    if let Ok(ip) = canonical.parse::<IpAddr>() {
        if ip.is_loopback() || ip.is_unspecified() {
            return Err(format!("{name} must point to an external durable service"));
        }
    }
    Ok(())
}

fn validate_s3_endpoint(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "BUZZ_S3_ENDPOINT must be a valid HTTPS origin")?;
    let host = url
        .host_str()
        .ok_or("BUZZ_S3_ENDPOINT must include a host")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("BUZZ_S3_ENDPOINT must be one HTTPS origin".to_string());
    }
    validate_external_host(host, "BUZZ_S3_ENDPOINT")
}

fn validate_nonempty_secret(value: &str, name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(())
    }
}

fn validate_s3_bucket(value: &str) -> Result<(), String> {
    let valid = (3..=63).contains(&value.len())
        && !value.starts_with('.')
        && !value.starts_with('-')
        && !value.ends_with('.')
        && !value.ends_with('-')
        && !value.contains("..")
        && !value.contains(".-")
        && !value.contains("-.")
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        });
    if valid {
        Ok(())
    } else {
        Err("BUZZ_S3_BUCKET must be a canonical S3 bucket name".to_string())
    }
}

fn validate_https_origin(value: &str, name: &str) -> Result<(), String> {
    if value.contains(',') || value.contains('*') || value.ends_with('/') {
        return Err(format!("{name} must be one exact HTTPS origin"));
    }
    let url = Url::parse(value).map_err(|_| format!("{name} must be a valid HTTPS origin"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!("{name} must be one exact HTTPS origin"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    const KEY: &str = "bpc_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

    #[test]
    fn derives_one_stable_non_enumerable_host_per_environment_and_key() {
        let first = derive_community_host(KEY, "production", "chat.bluplai.com").unwrap();
        let retry = derive_community_host(KEY, "production", "chat.bluplai.com").unwrap();
        assert_eq!(first, retry);
        assert_eq!(
            first,
            "org-e253f1d73b9344f471d871e542d9dd857e3cf312.chat.bluplai.com"
        );
        assert!(first.starts_with("org-"));
        assert!(first.ends_with(".chat.bluplai.com"));
        assert!(!first.contains(KEY));

        assert_ne!(
            first,
            derive_community_host(KEY, "staging", "chat.bluplai.com").unwrap()
        );
    }

    #[test]
    fn rejects_malformed_or_weak_organization_keys() {
        for key in [
            "",
            "short",
            "contains whitespace 012345678901234567890123456789",
            "unicode-ä-0123456789012345678901234567890123456789",
            "slash/012345678901234567890123456789012345678901",
        ] {
            assert!(
                derive_community_host(key, "production", "chat.bluplai.com").is_err(),
                "key {key:?} must fail closed"
            );
        }
    }

    #[test]
    fn rejects_noncanonical_environment_or_base_domain() {
        for environment in ["", "Production", "prod.eu", "prod_1", "prød"] {
            assert!(
                derive_community_host(KEY, environment, "chat.bluplai.com").is_err(),
                "environment {environment:?} must fail closed"
            );
        }
        for domain in [
            "",
            "Chat.Bluplai.com",
            "chat.bluplai.com.",
            "chat.bluplai.com:443",
            "https://chat.bluplai.com",
            "chat.blüplai.com",
            "chat_bluplai.com",
        ] {
            assert!(
                derive_community_host(KEY, "production", domain).is_err(),
                "domain {domain:?} must fail closed"
            );
        }
    }

    #[test]
    fn production_requires_digest_pin_auth_membership_and_exact_https_origin() {
        let valid = ProductionDeployment {
            image: "ghcr.io/bluplai/buzz@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            caddy_image: "caddy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            database_url: "postgresql://buzz:secret@db.internal:5432/buzz?sslmode=require",
            redis_url: "rediss://:secret@cache.internal:6379",
            s3_endpoint: "https://s3.eu-central-1.amazonaws.com",
            s3_access_key: "access-key",
            s3_secret_key: "secret-key",
            s3_bucket: "bluplai-buzz-production",
            s3_addressing_style: "virtual",
            require_auth_token: true,
            require_relay_membership: true,
            cors_origins: "https://app.bluplai.com",
            browser_origin: "https://app.bluplai.com",
            auto_migrate: false,
        };
        assert!(validate_production_deployment(valid).is_ok());

        let invalid = [
            ProductionDeployment {
                image: "ghcr.io/bluplai/buzz:main",
                ..valid
            },
            ProductionDeployment {
                image: "ghcr.io/bluplai/buzz:sha-deadbee",
                ..valid
            },
            ProductionDeployment {
                caddy_image: "caddy:2-alpine",
                ..valid
            },
            ProductionDeployment {
                database_url: "postgres://buzz:secret@postgres:5432/buzz",
                ..valid
            },
            ProductionDeployment {
                database_url: "postgresql://buzz:secret@db.internal:5432/buzz",
                ..valid
            },
            ProductionDeployment {
                redis_url: "redis://:secret@redis:6379",
                ..valid
            },
            ProductionDeployment {
                redis_url: "redis://:secret@cache.internal:6379",
                ..valid
            },
            ProductionDeployment {
                s3_endpoint: "http://minio:9000",
                ..valid
            },
            ProductionDeployment {
                s3_access_key: "",
                ..valid
            },
            ProductionDeployment {
                s3_secret_key: "",
                ..valid
            },
            ProductionDeployment {
                s3_bucket: "",
                ..valid
            },
            ProductionDeployment {
                s3_addressing_style: "automatic",
                ..valid
            },
            ProductionDeployment {
                require_auth_token: false,
                ..valid
            },
            ProductionDeployment {
                require_relay_membership: false,
                ..valid
            },
            ProductionDeployment {
                cors_origins: "*",
                ..valid
            },
            ProductionDeployment {
                cors_origins: "",
                ..valid
            },
            ProductionDeployment {
                cors_origins: "https://app.bluplai.com,https://evil.example",
                ..valid
            },
            ProductionDeployment {
                browser_origin: "http://app.bluplai.com",
                ..valid
            },
            ProductionDeployment {
                browser_origin: "https://other.bluplai.com",
                ..valid
            },
            ProductionDeployment {
                auto_migrate: true,
                ..valid
            },
        ];
        for deployment in invalid {
            assert!(validate_production_deployment(deployment).is_err());
        }
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn provisioning_retry_returns_the_same_community() {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5432/buzz".to_string());
        let pool = sqlx::PgPool::connect(&database_url).await.unwrap();
        let db = Db::from_pool(pool.clone());
        let config = ProvisioningConfig {
            environment: "test".to_string(),
            base_domain: "chat.test.invalid".to_string(),
            image: "ghcr.io/bluplai/buzz@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            caddy_image: "caddy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            // The pool above is the explicit local test harness. The config
            // value exercises the production preflight contract only; it is
            // not used to open a second connection in this test.
            database_url: "postgresql://buzz:secret@db.test.invalid:5432/buzz?sslmode=require"
                .to_string(),
            redis_url: "rediss://:secret@cache.test.invalid:6379".to_string(),
            s3_endpoint: "https://s3.test.invalid".to_string(),
            s3_access_key: "access-key".to_string(),
            s3_secret_key: "secret-key".to_string(),
            s3_bucket: "bluplai-buzz-test".to_string(),
            s3_addressing_style: "virtual".to_string(),
            require_auth_token: true,
            require_relay_membership: true,
            cors_origins: "https://app.test.invalid".to_string(),
            browser_origin: "https://app.test.invalid".to_string(),
            auto_migrate: false,
        };
        let key = format!("bpc_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

        let first = provision(&db, &key, &config).await.unwrap();
        let retry = provision(&db, &key, &config).await.unwrap();
        assert_eq!(first.community_id, retry.community_id);
        assert_eq!(first.host, retry.host);
        assert_eq!(first.status, "created");
        assert_eq!(retry.status, "existing");

        sqlx::query("DELETE FROM communities WHERE id = $1")
            .bind(Uuid::parse_str(&first.community_id).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
}
