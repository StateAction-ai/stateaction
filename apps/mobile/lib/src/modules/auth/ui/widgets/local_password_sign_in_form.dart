import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:provider/provider.dart";
import "package:stera/src/core/common/utils/extensions.dart";
import "package:stera/src/core/common/widgets/app_button/app_button.dart";
import "package:stera/src/core/common/widgets/app_button/enums/button_type.dart";
import "package:stera/src/core/common/widgets/app_text_field/app_text_field.dart";
import "package:stera/src/core/theme/app_spacing.dart";
import "package:stera/src/modules/auth/data/models/app_auth_type.dart";
import "package:stera/src/modules/auth/providers/auth_provider.dart";

/// Opt-in development sign-in with a seeded email/password account on the
/// same Better Auth instance, sessions and roles as Google. Shown only when
/// `LOCAL_PASSWORD_AUTH=true`. The password lives in this widget's controller
/// only and is never logged or stored.
class LocalPasswordSignInForm extends StatefulWidget {
  const LocalPasswordSignInForm({required this.onSignedIn, super.key});

  final VoidCallback onSignedIn;

  static const Key emailKey = Key("local-password-email");
  static const Key passwordKey = Key("local-password-password");
  static const Key submitKey = Key("local-password-submit");

  @override
  State<LocalPasswordSignInForm> createState() =>
      _LocalPasswordSignInFormState();
}

class _LocalPasswordSignInFormState extends State<LocalPasswordSignInForm> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final email = _email.text.trim();
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = "Enter your email and password.");
      return;
    }
    HapticFeedback.lightImpact();
    setState(() {
      _busy = true;
      _error = null;
    });
    final failure = await context.read<AuthProvider>().onAuth(
      type: AppAuthType.localPassword,
      email: email,
      password: password,
    );
    if (!mounted) return;
    _password.clear();
    setState(() {
      _busy = false;
      _error = failure?.message;
    });
    if (failure == null) widget.onSignedIn();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          "Development sign-in",
          style: context.textTheme.bodyMdMedium.copyWith(
            color: context.colors.textSecondary,
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        AppTextField(
          key: LocalPasswordSignInForm.emailKey,
          controller: _email,
          hintText: "Email",
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.next,
          enabled: !_busy,
        ),
        const SizedBox(height: AppSpacing.sm),
        AppTextField(
          key: LocalPasswordSignInForm.passwordKey,
          controller: _password,
          hintText: "Password",
          obscureText: true,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submit(),
          enabled: !_busy,
          errorText: _error,
        ),
        const SizedBox(height: AppSpacing.md),
        AppButton(
          key: LocalPasswordSignInForm.submitKey,
          type: ButtonType.secondary,
          text: "Sign in with email",
          isLoading: _busy,
          isDisabled: _busy,
          onPressed: _submit,
        ),
      ],
    );
  }
}
