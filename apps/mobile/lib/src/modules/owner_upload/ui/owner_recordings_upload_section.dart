import "dart:async";

import "package:flutter/foundation.dart";
import "package:flutter/material.dart";
import "package:provider/provider.dart";
import "package:stera/src/core/common/formatters/format_bytes.dart";
import "package:stera/src/core/common/utils/extensions.dart";
import "package:stera/src/core/common/widgets/app_button/app_button.dart";
import "package:stera/src/core/common/widgets/app_button/enums/button_sizes.dart";
import "package:stera/src/core/common/widgets/app_button/enums/button_type.dart";
import "package:stera/src/core/common/widgets/app_card.dart";
import "package:stera/src/core/common/widgets/app_slider_dialog.dart";
import "package:stera/src/core/common/widgets/section_header.dart";
import "package:stera/src/core/theme/app_radii.dart";
import "package:stera/src/core/theme/app_spacing.dart";
import "package:stera/src/modules/auth/session/auth_services.dart";
import "package:stera/src/modules/auth/ui/widgets/login_modal.dart";
import "package:stera/src/modules/home/data/enums/current_page.dart";
import "package:stera/src/modules/home/providers/navigation_provider.dart";
import "package:stera/src/modules/owner_upload/native_source_guard.dart";
import "package:stera/src/modules/owner_upload/owner_upload_controller.dart";
import "package:stera/src/modules/owner_upload/owner_upload_services.dart";
import "package:stera/src/modules/owner_upload/source_cleanup_service.dart";
import "package:stera/src/modules/owner_upload/take_evidence.dart";
import "package:stera/src/modules/owner_upload/take_upload_view.dart";
import "package:stera/src/modules/owner_upload/transfer_policy_override.dart";
import "package:stera/src/modules/recordings/providers/recordings_provider.dart";
import "package:stera/src/modules/recordings/ui/widgets/recording_session_tile.dart";
import "package:stera/src/services/recordings_service/data/models/recording_session.dart";
import "package:stera_recorder/stera_recorder.dart";

/// Upload / Resume controls for the signed-in user's own recorded takes.
/// Renders nothing unless the owner-bound native uploader is enabled, so the
/// existing Home layout is untouched in every other build.
class OwnerRecordingsUploadSection extends StatefulWidget {
  const OwnerRecordingsUploadSection({super.key});

  @override
  State<OwnerRecordingsUploadSection> createState() =>
      _OwnerRecordingsUploadSectionState();
}

class _OwnerRecordingsUploadSectionState
    extends State<OwnerRecordingsUploadSection>
    with WidgetsBindingObserver {
  OwnerUploadController? get _controller =>
      OwnerUploadServices.maybeInstance?.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    NativeSourceGuard.takesChanged.addListener(_refresh);
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
    _navigation = context.read<NavigationProvider>()
      ..addListener(_onNavigation);
    _syncSubscriptions();
    // Transfers run natively while Dart is idle: while this surface is actually
    // on screen (app resumed, Home visible, no capture running) re-read their
    // state so progress, Resume and completion stay current.
    _poll = Timer.periodic(const Duration(seconds: 3), (_) {
      if (_onScreen()) _refresh();
    });
  }

  /// App resumed, this tab/route visible, and the recorder not capturing.
  bool _onScreen() {
    if (!mounted) return false;
    if (WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
      return false;
    }
    if (!TickerMode.valuesOf(context).enabled) return false;
    if (ModalRoute.of(context)?.isCurrent == false) return false;
    final recorder = context.read<ArRecorderProvider>();
    return !recorder.isRecording && recorder.state != ArRecorderState.stopping;
  }

  void _onNavigation() {
    if (mounted && _navigation?.currentPage == CurrentPage.home) _refresh();
  }

  NavigationProvider? _navigation;
  List<Listenable> _watched = const [];
  OwnerUploadController? _subscribedController;

  /// The controller, take list or session changed: rebuild from their state.
  void _onChanged() {
    if (mounted) setState(() {});
  }

  /// Attaches to exactly the controller the section reads now. The singleton can
  /// appear after initState (or be replaced in tests), so this is re-run from
  /// build and never leaves a subscription to a controller that is not the one
  /// being read.
  void _syncSubscriptions() {
    final current = _controller;
    if (identical(current, _subscribedController) && _watched.isNotEmpty) {
      return;
    }
    for (final listenable in _watched) {
      listenable.removeListener(_onChanged);
    }
    _subscribedController = current;
    _watched = [
      ?current,
      context.read<RecordingsProvider>(),
      ?AuthServices.maybeInstance?.controller,
    ];
    for (final listenable in _watched) {
      listenable.addListener(_onChanged);
    }
  }

  Timer? _poll;
  bool _refreshing = false;
  int _generation = 0;

  @override
  void dispose() {
    _poll?.cancel();
    _generation++;
    _navigation?.removeListener(_onNavigation);
    for (final listenable in _watched) {
      listenable.removeListener(_onChanged);
    }
    NativeSourceGuard.takesChanged.removeListener(_refresh);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  void _refresh() {
    final controller = _controller;
    if (!mounted || controller == null || !controller.enabled) return;
    if (_refreshing) return;
    _refreshing = true;
    final generation = ++_generation;
    final provider = context.read<RecordingsProvider>();
    unawaited(
      provider
          .loadSessions()
          .then((_) {
            // A newer refresh, a dispose or a navigation away supersedes this one.
            if (mounted && generation == _generation) {
              return controller.refresh(provider.sessions);
            }
          })
          .whenComplete(() => _refreshing = false),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null || !controller.enabled) {
      return const SizedBox.shrink();
    }
    _syncSubscriptions();
    final sessions = context.read<RecordingsProvider>().sessions;
    final rows = [
      for (final session in sessions)
        if (_visible(controller.viewFor(session.directoryName)))
          (session, controller.viewFor(session.directoryName)),
    ];
    if (kDebugMode) {
      // Debug builds only; counts, stage names and the instance hash only:
      // proves this surface reads the controller instance the refresh updates.
      debugPrint(
        "owner-upload section: controller#${identityHashCode(controller)} "
        "${sessions.length} takes, ${rows.length} rows, "
        "onScreen=${mounted && _onScreen()} "
        "views=${[for (final t in sessions) controller.viewFor(t.directoryName).stage.name]}",
      );
    }

    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.lg),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SectionHeader(
              title: "Your recordings",
              number: rows.length,
              subtitle: rows.isEmpty
                  ? "Sign in with the account that made a recording to upload it."
                  : "Upload to your account",
            ),
            if (rows.isNotEmpty) AppSpacing.gapMd,
            for (final (session, view) in rows)
              OwnerTakeRow(
                session: session,
                view: view,
                onAction: () => _act(controller, session, view),
                onCleanup: view.canCleanup && controller.cleanupAvailable
                    ? () => _cleanup(controller, session)
                    : null,
              ),
            TransferPolicyControls(controller: controller),
          ],
        ),
      ),
    );
  }

  static bool _visible(TakeUploadView view) =>
      view.stage != UploadStage.hidden &&
      view.stage != UploadStage.otherAccount;

  /// Explicit consent first (a dialog that names what goes and what stays);
  /// only after "Check and remove" does the controller ask the server for a
  /// fresh proof, so time spent reading the dialog cannot shorten or extend
  /// one. Cancelling or any refusal leaves every file in place.
  Future<void> _cleanup(
    OwnerUploadController controller,
    RecordingSession session,
  ) async {
    final LocalCleanupOffer offer;
    try {
      offer = await controller.prepareLocalCleanup(session);
    } on CleanupDenied catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(OwnerUploadController.cleanupDeniedView(e).message),
        ),
      );
      return;
    }
    if (!mounted) return;
    final agreed = await confirmLocalCleanup(context, offer);
    if (!agreed || !mounted) return;
    final result = await controller.cleanupLocalOriginals(session, offer);
    if (mounted &&
        result.stage != UploadStage.localCleaned &&
        result.stage != UploadStage.hidden) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(result.message)));
    }
  }

  Future<void> _act(
    OwnerUploadController controller,
    RecordingSession session,
    TakeUploadView view,
  ) async {
    switch (view.action) {
      case UploadAction.upload || UploadAction.resume:
        await controller.startOrResume(session);
      case UploadAction.restart:
        await controller.restart(session);
      case UploadAction.signIn:
        AppSliderDialog.showAppSliderDialog(
          context: context,
          content: const LoginModal(),
        );
      case UploadAction.none:
        break;
    }
  }
}

/// The explicit consent dialog for removing the sealed local originals. True
/// only for the "Check and remove" button; dismissing, cancelling or any other
/// result is a refusal. It names what is deleted and what stays, and says the
/// staff cloud-copy confirmation is checked by the server, not assumed.
Future<bool> confirmLocalCleanup(
  BuildContext context,
  LocalCleanupOffer offer,
) async {
  final agreed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      key: const ValueKey("cleanup-dialog"),
      title: const Text("Remove local originals?"),
      content: Text(
        "This permanently deletes ${offer.originalCount} original "
        "file${offer.originalCount == 1 ? "" : "s"} "
        "(${formatBytes(offer.totalBytes.toInt())}) of this recording from "
        "this phone. The server is asked to re-check its cloud copy right "
        "after you confirm, and nothing is deleted unless staff have "
        "confirmed that copy. This is not a reviewer's approval of the "
        "recording. The upload record stays. This cannot be undone.",
      ),
      actions: [
        TextButton(
          key: const ValueKey("cleanup-dialog-cancel"),
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text("Keep files"),
        ),
        TextButton(
          key: const ValueKey("cleanup-dialog-confirm"),
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text("Check and remove"),
        ),
      ],
    ),
  );
  return agreed == true;
}

/// One take with its honest upload state and action.
///
/// The action is a full-width [AppButton] under the text (the app's own button
/// is `double.infinity` wide by default, so it cannot sit in a `Row` beside an
/// `Expanded` label without breaking layout).
class OwnerTakeRow extends StatelessWidget {
  const OwnerTakeRow({
    required this.session,
    required this.view,
    required this.onAction,
    this.onCleanup,
    super.key,
  });

  final RecordingSession session;
  final TakeUploadView view;
  final VoidCallback onAction;

  /// Null unless this take may offer the explicit local-original cleanup.
  final VoidCallback? onCleanup;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final fraction = view.fraction;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            RecordingSessionTile.titleFor(session),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.textTheme.bodySm.copyWith(color: colors.textPrimary),
          ),
          Text(
            view.message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: context.textTheme.bodyXs.copyWith(
              color:
                  view.stage == UploadStage.failed ||
                      view.stage == UploadStage.blocked ||
                      view.stage == UploadStage.interrupted
                  ? colors.textDestructive
                  : colors.textSecondary,
            ),
          ),
          if (view.evidence.uploaded == Proof.yes)
            Text(
              view.evidence.details,
              key: ValueKey("owner-evidence-${session.directoryName}"),
              style: context.textTheme.bodyXs.copyWith(
                color: colors.textSecondary,
              ),
            ),
          if (view.isBusy && view.partCount > 0) ...[
            AppSpacing.gapSm,
            ClipRRect(
              borderRadius: BorderRadius.circular(AppRadii.xs),
              child: LinearProgressIndicator(
                value: fraction,
                backgroundColor: colors.neutralLightGray,
                color: colors.textPrimary,
              ),
            ),
          ],
          if (view.action != UploadAction.none) ...[
            AppSpacing.gapSm,
            AppButton(
              key: ValueKey("owner-upload-${session.directoryName}"),
              text: view.actionLabel,
              type: ButtonType.secondary,
              size: ButtonSizes.sm,
              isLoading: view.stage == UploadStage.working,
              onPressed: onAction,
            ),
          ],
          if (onCleanup != null && !view.isBusy) ...[
            AppSpacing.gapSm,
            AppButton(
              key: ValueKey("owner-cleanup-${session.directoryName}"),
              text: "Check cloud copy and remove local originals",
              type: ButtonType.tertiary,
              size: ButtonSizes.sm,
              onPressed: onCleanup,
            ),
          ],
        ],
      ),
    );
  }
}

/// Wi-Fi-only and charging-required are on by default. Turning either off is an
/// explicit choice that applies to this account only and is reset for anyone
/// else. Capture still pauses every transfer.
class TransferPolicyControls extends StatefulWidget {
  const TransferPolicyControls({required this.controller, super.key});

  final OwnerUploadController controller;

  @override
  State<TransferPolicyControls> createState() => _TransferPolicyControlsState();
}

class _TransferPolicyControlsState extends State<TransferPolicyControls> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final view = widget.controller.policyView;
    final choice = view.choice;
    final editable = view.editable;
    void set(TransferPolicyChoice next) =>
        unawaited(widget.controller.setTransferPolicy(next));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile(
          key: const ValueKey("policy-wifi-only"),
          contentPadding: EdgeInsets.zero,
          title: const Text("Upload on Wi-Fi only"),
          value: choice.requireUnmetered,
          onChanged: editable
              ? (v) => set(
                  TransferPolicyChoice(
                    requireUnmetered: v,
                    requireCharging: choice.requireCharging,
                  ),
                )
              : null,
        ),
        SwitchListTile(
          key: const ValueKey("policy-charging-only"),
          contentPadding: EdgeInsets.zero,
          title: const Text("Upload only while charging"),
          value: choice.requireCharging,
          onChanged: editable
              ? (v) => set(
                  TransferPolicyChoice(
                    requireUnmetered: choice.requireUnmetered,
                    requireCharging: v,
                  ),
                )
              : null,
        ),
        if (view.message != null)
          Text(
            view.message!,
            key: const ValueKey("policy-message"),
            style: context.textTheme.bodyXs,
          ),
      ],
    );
  }
}
