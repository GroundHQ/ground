import 'package:flutter/widgets.dart';
import 'package:ground/models/board.dart';
import 'package:ground/ui/boards/board_list.dart';
import 'package:ground/ui/core/themes/theme_extensions.dart';
import 'package:ground/ui/widgets/avatar.dart';
import 'package:ground/ui/widgets/navigation_stack.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return NavigationStack(
      title: 'Boards',
      leading: Avatar(name: 'Andrei', size: context.icons.lg),
      bottomBar: Container(
        padding: EdgeInsets.symmetric(
          horizontal: context.spacing.md,
          vertical: context.spacing.sm,
        ),
        child: Text(
          '30 boards',
          style: context.text.small.copyWith(
            color: context.colors.inkSecondary,
          ),
        ),
      ),
      // trailing: const [ThemeToggleButton()],
      child: BoardList(
        boards: _generateSampleBoards(),
        onBoardTap: (board) {
          // Handle board tap
          debugPrint('Tapped board: ${board.name}');
        },
      ),
    );
  }

  List<Board> _generateSampleBoards() {
    final usernames = [
      'Alice Johnson',
      'Bob Smith',
      'Charlie Brown',
      'Diana Prince',
      'Edward Norton',
      'Fiona Apple',
      'George Lucas',
      'Hannah Montana',
      'Ian McKellen',
      'Julia Roberts'
    ];

    final actions = [
      'added a new card',
      'commented on a task',
      'moved a card',
      'created a new list',
      'archived a card',
      'mentioned you',
      'assigned you a task',
      'shared a file',
      'updated the description of the board',
      'set a due date'
    ];

    final boardNames = [
      'Product Development',
      'Marketing Campaign',
      'Website Redesign',
      'Mobile App Launch',
      'Content Strategy',
      'Customer Feedback',
      'Team Projects',
      'Research & Analytics',
      'Design Systems',
      'Operations'
    ];

    final now = DateTime.now();

    return List.generate(30, (index) {
      final random = index % 10; // Use modulo to cycle through the sample data

      return Board(
        id: index,
        name: '${boardNames[random]} ${(index ~/ 10) + 1}',
        username: usernames[random],
        lastAction: LastAction(
          user: usernames[random],
          action: actions[random],
          date: now.subtract(Duration(
            minutes: index * 17, // Spread out the timestamps
          )),
        ),
      );
    });
  }
}
