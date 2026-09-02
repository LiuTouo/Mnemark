use crate::models::AppConfig;

/// Production and fake capabilities used by the config transaction. Each
/// method wraps one existing external mechanism; the transaction owns their
/// ordering and rollback policy.
pub(crate) trait ConfigEffects {
    fn hotkey_change_needed(&self, old_hotkey: &str, new_hotkey: &str) -> bool;
    fn apply_hotkey(&self, old_hotkey: &str, new_hotkey: &str) -> Result<(), String>;
    fn undo_hotkey(&self, new_hotkey: &str, old_hotkey: &str) -> Result<(), String>;
    fn set_startup(&self, enabled: bool) -> Result<(), String>;
    fn set_persistence(&self, enabled: bool) -> Result<(), String>;
    fn save_config(&self, config: &AppConfig) -> Result<(), String>;
}

struct ConfigEffect<'a> {
    apply: Box<dyn FnMut() -> Result<(), String> + 'a>,
    undo: Box<dyn FnMut() -> Result<(), String> + 'a>,
}

impl<'a> ConfigEffect<'a> {
    fn new(
        apply: impl FnMut() -> Result<(), String> + 'a,
        undo: impl FnMut() -> Result<(), String> + 'a,
    ) -> Self {
        Self {
            apply: Box::new(apply),
            undo: Box::new(undo),
        }
    }
}

struct ConfigTransaction<'a> {
    effects: Vec<ConfigEffect<'a>>,
}

impl<'a> ConfigTransaction<'a> {
    fn new(effects: Vec<ConfigEffect<'a>>) -> Self {
        Self { effects }
    }

    fn run(&mut self, commit: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let mut applied = 0;
        while applied < self.effects.len() {
            if let Err(error) = (self.effects[applied].apply)() {
                self.rollback(applied);
                return Err(error);
            }
            applied += 1;
        }

        if let Err(error) = commit() {
            self.rollback(applied);
            return Err(error);
        }

        Ok(())
    }

    fn rollback(&mut self, applied: usize) {
        for effect in self.effects[..applied].iter_mut().rev() {
            // Preserve the previous handler's behavior: keep rolling back and
            // surface the original apply/commit error if an undo fails.
            let _ = (effect.undo)();
        }
    }
}

/// Capture the old config, validate the target, apply changed effects, save the
/// config, and only then run non-transactional follow-ups.
pub(crate) fn run_config_update<E: ConfigEffects>(
    capture_snapshot: impl FnOnce() -> AppConfig,
    new_config: &AppConfig,
    validate: impl FnOnce(&AppConfig, &AppConfig) -> Result<(), String>,
    effects: &E,
    follow_ups: impl FnOnce(&AppConfig, &AppConfig),
) -> Result<(), String> {
    let old_config = capture_snapshot();
    validate(new_config, &old_config)?;

    let mut ordered_effects = Vec::new();
    // Hotkey remains first so a registration conflict occurs before any other
    // external state changes. Reverse rollback order is therefore derived as
    // persistence, startup, hotkey, matching the previous handler.
    if new_config.hotkey != old_config.hotkey
        && effects.hotkey_change_needed(&old_config.hotkey, &new_config.hotkey)
    {
        ordered_effects.push(ConfigEffect::new(
            || effects.apply_hotkey(&old_config.hotkey, &new_config.hotkey),
            || effects.undo_hotkey(&new_config.hotkey, &old_config.hotkey),
        ));
    }
    if new_config.startup != old_config.startup {
        ordered_effects.push(ConfigEffect::new(
            || effects.set_startup(new_config.startup),
            || effects.set_startup(old_config.startup),
        ));
    }
    if new_config.persist != old_config.persist {
        ordered_effects.push(ConfigEffect::new(
            || effects.set_persistence(new_config.persist),
            || effects.set_persistence(old_config.persist),
        ));
    }

    ConfigTransaction::new(ordered_effects).run(|| effects.save_config(new_config))?;
    follow_ups(new_config, &old_config);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{run_config_update, ConfigEffects};
    use crate::models::AppConfig;
    use std::cell::RefCell;
    use std::rc::Rc;

    type Events = Rc<RefCell<Vec<&'static str>>>;

    struct FakeEffects {
        events: Events,
        target: AppConfig,
        current: RefCell<AppConfig>,
        hotkey_change_needed: bool,
        failed_apply: Option<&'static str>,
        failed_undo: Option<&'static str>,
        commit_error: Option<&'static str>,
    }

    impl FakeEffects {
        fn new(events: &Events, old_config: &AppConfig, target: &AppConfig) -> Self {
            Self {
                events: Rc::clone(events),
                target: target.clone(),
                current: RefCell::new(old_config.clone()),
                hotkey_change_needed: true,
                failed_apply: None,
                failed_undo: None,
                commit_error: None,
            }
        }

        fn record_apply(&self, effect: &'static str, event: &'static str) -> Result<(), String> {
            self.events.borrow_mut().push(event);
            if self.failed_apply == Some(effect) {
                Err(format!("{effect} failed"))
            } else {
                Ok(())
            }
        }

        fn record_undo(&self, effect: &'static str, event: &'static str) -> Result<(), String> {
            self.events.borrow_mut().push(event);
            if self.failed_undo == Some(effect) {
                Err(format!("undo {effect} failed"))
            } else {
                Ok(())
            }
        }
    }

    impl ConfigEffects for FakeEffects {
        fn hotkey_change_needed(&self, old_hotkey: &str, new_hotkey: &str) -> bool {
            assert_ne!(old_hotkey, new_hotkey);
            self.hotkey_change_needed
        }

        fn apply_hotkey(&self, old_hotkey: &str, new_hotkey: &str) -> Result<(), String> {
            self.record_apply("hotkey", "apply:hotkey")?;
            assert_eq!(self.current.borrow().hotkey, old_hotkey);
            self.current.borrow_mut().hotkey = new_hotkey.to_string();
            Ok(())
        }

        fn undo_hotkey(&self, new_hotkey: &str, old_hotkey: &str) -> Result<(), String> {
            self.record_undo("hotkey", "undo:hotkey")?;
            assert_eq!(self.current.borrow().hotkey, new_hotkey);
            self.current.borrow_mut().hotkey = old_hotkey.to_string();
            Ok(())
        }

        fn set_startup(&self, enabled: bool) -> Result<(), String> {
            let applying = enabled == self.target.startup;
            if applying {
                self.record_apply("startup", "apply:startup")?;
            } else {
                self.record_undo("startup", "undo:startup")?;
            }
            self.current.borrow_mut().startup = enabled;
            Ok(())
        }

        fn set_persistence(&self, enabled: bool) -> Result<(), String> {
            let applying = enabled == self.target.persist;
            if applying {
                self.record_apply("persistence", "apply:persistence")?;
            } else {
                self.record_undo("persistence", "undo:persistence")?;
            }
            self.current.borrow_mut().persist = enabled;
            Ok(())
        }

        fn save_config(&self, config: &AppConfig) -> Result<(), String> {
            self.events.borrow_mut().push("commit");
            assert_eq!(config.hotkey, self.target.hotkey);
            self.commit_error.map_or(Ok(()), |error| Err(error.into()))
        }
    }

    fn changed_configs() -> (AppConfig, AppConfig) {
        let old_config = AppConfig::default();
        let mut new_config = old_config.clone();
        new_config.hotkey = "Ctrl+Shift+B".to_string();
        new_config.startup = !old_config.startup;
        new_config.persist = !old_config.persist;
        (old_config, new_config)
    }

    fn execute(
        events: &Events,
        old_config: &AppConfig,
        new_config: &AppConfig,
        effects: &FakeEffects,
        validation_error: Option<&str>,
    ) -> Result<(), String> {
        let snapshot_events = Rc::clone(events);
        let validation_events = Rc::clone(events);
        let follow_up_events = Rc::clone(events);
        run_config_update(
            move || {
                snapshot_events.borrow_mut().push("snapshot");
                old_config.clone()
            },
            new_config,
            move |_, _| {
                validation_events.borrow_mut().push("validate");
                validation_error.map_or(Ok(()), |error| Err(error.to_string()))
            },
            effects,
            move |_, _| follow_up_events.borrow_mut().push("follow-up"),
        )
    }

    #[test]
    fn all_effects_apply_before_commit_and_follow_ups() {
        let events = Events::default();
        let (old_config, new_config) = changed_configs();
        let effects = FakeEffects::new(&events, &old_config, &new_config);

        execute(&events, &old_config, &new_config, &effects, None).unwrap();

        assert_eq!(
            *events.borrow(),
            [
                "snapshot",
                "validate",
                "apply:hotkey",
                "apply:startup",
                "apply:persistence",
                "commit",
                "follow-up",
            ]
        );
        let current = effects.current.borrow();
        assert_eq!(current.hotkey, new_config.hotkey);
        assert_eq!(current.startup, new_config.startup);
        assert_eq!(current.persist, new_config.persist);
    }

    #[test]
    fn apply_failure_rolls_back_only_applied_effects_in_reverse_order() {
        let cases = [
            ("hotkey", vec!["snapshot", "validate", "apply:hotkey"]),
            (
                "startup",
                vec![
                    "snapshot",
                    "validate",
                    "apply:hotkey",
                    "apply:startup",
                    "undo:hotkey",
                ],
            ),
            (
                "persistence",
                vec![
                    "snapshot",
                    "validate",
                    "apply:hotkey",
                    "apply:startup",
                    "apply:persistence",
                    "undo:startup",
                    "undo:hotkey",
                ],
            ),
        ];

        for (failed_apply, expected_events) in cases {
            let events = Events::default();
            let (old_config, new_config) = changed_configs();
            let mut effects = FakeEffects::new(&events, &old_config, &new_config);
            effects.failed_apply = Some(failed_apply);

            let error = execute(&events, &old_config, &new_config, &effects, None).unwrap_err();

            assert_eq!(error, format!("{failed_apply} failed"));
            assert_eq!(*events.borrow(), expected_events);
            let current = effects.current.borrow();
            assert_eq!(current.hotkey, old_config.hotkey);
            assert_eq!(current.startup, old_config.startup);
            assert_eq!(current.persist, old_config.persist);
        }
    }

    #[test]
    fn semantically_equivalent_hotkey_does_not_create_an_effect() {
        let events = Events::default();
        let (old_config, new_config) = changed_configs();
        let mut effects = FakeEffects::new(&events, &old_config, &new_config);
        effects.hotkey_change_needed = false;

        execute(&events, &old_config, &new_config, &effects, None).unwrap();

        assert_eq!(
            *events.borrow(),
            [
                "snapshot",
                "validate",
                "apply:startup",
                "apply:persistence",
                "commit",
                "follow-up",
            ]
        );
    }

    #[test]
    fn commit_failure_rolls_back_every_effect_in_reverse_order() {
        let events = Events::default();
        let (old_config, new_config) = changed_configs();
        let mut effects = FakeEffects::new(&events, &old_config, &new_config);
        effects.commit_error = Some("save failed");

        let error = execute(&events, &old_config, &new_config, &effects, None).unwrap_err();

        assert_eq!(error, "save failed");
        assert_eq!(
            *events.borrow(),
            [
                "snapshot",
                "validate",
                "apply:hotkey",
                "apply:startup",
                "apply:persistence",
                "commit",
                "undo:persistence",
                "undo:startup",
                "undo:hotkey",
            ]
        );
        let current = effects.current.borrow();
        assert_eq!(current.hotkey, old_config.hotkey);
        assert_eq!(current.startup, old_config.startup);
        assert_eq!(current.persist, old_config.persist);
    }

    #[test]
    fn undo_failure_keeps_original_error_and_continues_rollback() {
        let events = Events::default();
        let (old_config, new_config) = changed_configs();
        let mut effects = FakeEffects::new(&events, &old_config, &new_config);
        effects.failed_apply = Some("persistence");
        effects.failed_undo = Some("startup");

        let error = execute(&events, &old_config, &new_config, &effects, None).unwrap_err();

        assert_eq!(error, "persistence failed");
        assert_eq!(
            *events.borrow(),
            [
                "snapshot",
                "validate",
                "apply:hotkey",
                "apply:startup",
                "apply:persistence",
                "undo:startup",
                "undo:hotkey",
            ]
        );
    }

    #[test]
    fn validation_failure_runs_no_effects_commit_or_follow_ups() {
        let events = Events::default();
        let (old_config, new_config) = changed_configs();
        let effects = FakeEffects::new(&events, &old_config, &new_config);

        let error =
            execute(&events, &old_config, &new_config, &effects, Some("invalid")).unwrap_err();

        assert_eq!(error, "invalid");
        assert_eq!(*events.borrow(), ["snapshot", "validate"]);
        let current = effects.current.borrow();
        assert_eq!(current.hotkey, old_config.hotkey);
        assert_eq!(current.startup, old_config.startup);
        assert_eq!(current.persist, old_config.persist);
    }
}
