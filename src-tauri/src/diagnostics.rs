//! Minimal Native startup diagnostics.

use tracing::Level;

use crate::{DegradedCause, Issue, RuntimeStatus};

/// Installs the development stderr subscriber when no subscriber exists yet.
///
/// Initialization is best-effort: an existing subscriber or an initialization
/// failure must never prevent startup or alter [`RuntimeStatus`].
pub(crate) fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .try_init();
}

/// Emits the single startup diagnostic currently backed by a real caller.
pub(crate) fn record_startup_status(status: &RuntimeStatus) {
    let RuntimeStatus::Degraded(cause) = status else {
        return;
    };

    let issue = match cause {
        DegradedCause::Bootstrap(issue)
        | DegradedCause::DataRoot(issue)
        | DegradedCause::Database(issue)
        | DegradedCause::PathResolver(issue) => issue,
    };

    record_degraded_issue(issue);
}

fn record_degraded_issue(issue: &Issue) {
    if let Some(path) = issue.path.as_deref() {
        tracing::event!(
            target: "zhixing::startup",
            Level::ERROR,
            diagnostic = "native_startup_degraded",
            subsystem = issue.subsystem,
            kind = issue.kind.as_str(),
            message = issue.message.as_str(),
            path = %path.display(),
        );
    } else {
        tracing::event!(
            target: "zhixing::startup",
            Level::ERROR,
            diagnostic = "native_startup_degraded",
            subsystem = issue.subsystem,
            kind = issue.kind.as_str(),
            message = issue.message.as_str(),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fmt,
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    use tracing::{
        field::{Field, Visit},
        Event, Subscriber,
    };
    use tracing_subscriber::{layer::Context, prelude::*, Layer};

    use super::*;

    #[derive(Clone, Debug)]
    struct CapturedEvent {
        level: Level,
        fields: HashMap<String, String>,
    }

    #[derive(Clone, Default)]
    struct CaptureLayer {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl<S> Layer<S> for CaptureLayer
    where
        S: Subscriber,
    {
        fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
            let mut visitor = FieldVisitor::default();
            event.record(&mut visitor);

            self.events
                .lock()
                .expect("capture lock must remain available")
                .push(CapturedEvent {
                    level: *event.metadata().level(),
                    fields: visitor.fields,
                });
        }
    }

    #[derive(Default)]
    struct FieldVisitor {
        fields: HashMap<String, String>,
    }

    impl Visit for FieldVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
            self.fields
                .insert(field.name().to_owned(), format!("{value:?}"));
        }

        fn record_str(&mut self, field: &Field, value: &str) {
            self.fields
                .insert(field.name().to_owned(), value.to_owned());
        }
    }

    fn capture(status: &RuntimeStatus) -> Vec<CapturedEvent> {
        let layer = CaptureLayer::default();
        let events = Arc::clone(&layer.events);
        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || record_startup_status(status));

        let captured = events
            .lock()
            .expect("capture lock must remain available")
            .clone();
        captured
    }

    #[test]
    fn degraded_status_emits_structured_error_event() {
        let path = PathBuf::from("sandbox").join("database").join("zhixing.db");
        let status = RuntimeStatus::Degraded(DegradedCause::Database(Issue {
            subsystem: "database",
            kind: "SqliteOpen".into(),
            path: Some(path.clone()),
            message: "SQLite open failed".into(),
        }));

        let events = capture(&status);

        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.level, Level::ERROR);
        assert_eq!(
            event.fields.get("diagnostic").map(String::as_str),
            Some("native_startup_degraded")
        );
        assert_eq!(
            event.fields.get("subsystem").map(String::as_str),
            Some("database")
        );
        assert_eq!(
            event.fields.get("kind").map(String::as_str),
            Some("SqliteOpen")
        );
        assert_eq!(
            event.fields.get("message").map(String::as_str),
            Some("SQLite open failed")
        );
        assert_eq!(
            event.fields.get("path").map(String::as_str),
            Some(path.display().to_string().as_str())
        );
    }

    #[test]
    fn healthy_status_emits_no_degraded_event() {
        assert!(capture(&RuntimeStatus::Healthy).is_empty());
    }
}
