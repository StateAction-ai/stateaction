import "package:stera/src/core/common/utils/extensions.dart";
import "package:stera/src/core/common/widgets/pressable.dart";
import "package:stera/src/core/common/widgets/section_header.dart";
import "package:stera/src/core/theme/app_radii.dart";
import "package:stera/src/core/theme/app_spacing.dart";
import "package:stera/src/modules/home/ui/widgets/recording_guide_bottomsheet.dart";
import "package:flutter/material.dart";
import "package:solar_icons/solar_icons.dart";

class RecordingGuideButton extends StatelessWidget {
  const RecordingGuideButton({super.key});

  void _openGuide(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (_) => const RecordingGuideBottomSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Pressable(
      behavior: HitTestBehavior.opaque,
      semanticLabel: "Open the step-by-step recording guide",
      onTap: () => _openGuide(context),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: ShapeDecoration(
          color: context.colors.neutralLightGray,
          shape: RoundedSuperellipseBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
          ),
        ),
        child: Row(
          spacing: AppSpacing.sm,
          children: [
            Icon(
              SolarIconsOutline.bookMinimalistic,
              color: context.colors.textPrimary,
              size: AppSpacing.lg,
            ),
            const Expanded(
              child: SectionHeader(
                title: "Step-by-step guide",
                subtitle: "Set up and record a take",
              ),
            ),
            Icon(
              SolarIconsOutline.arrowRight,
              color: context.colors.textPrimary,
              size: AppSpacing.lg,
            ),
          ],
        ),
      ),
    );
  }
}
